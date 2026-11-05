import { isDeepStrictEqual } from "node:util";
import { isPairedDeviceTokenIdentityCurrent } from "../infra/device-pairing-identity.js";
import { capturePublishedOperatorDeviceSource } from "../infra/device-pairing-publication.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  resolveUserChannelAuthorizationPolicy,
  userChannelIdentitySubject,
} from "../state/user-channel-identities.js";
import { prepareUserChannelIdentityAuthority } from "../state/user-channel-identity-operations.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { isGatewayAuthGrantCurrent } from "./auth-policy.js";
import {
  captureGatewayDeviceRevocation,
  onGatewayDeviceSourceRevoked,
} from "./device-revocation.js";
import { resumeGatewayOperatorAccessGrant } from "./operator-access-policy.js";
import {
  onOperatorRolePolicyChanged,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import type { OperatorRunRecoverySnapshot } from "./operator-run-recovery-source.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

export type GatewayOperatorSourceCustody = Readonly<{
  profileId: string;
  assertCurrent: () => void;
  signal: AbortSignal;
  retain: () => () => void;
  release: () => void;
}>;

/** Requalify the original native principal; this proof grants no model or tool execution. */
export async function prepareGatewayOperatorSourceCustody(params: {
  snapshot: OperatorRunRecoverySnapshot;
  context: GatewayRequestContext;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<GatewayOperatorSourceCustody> {
  const snapshot = freezeJsonSnapshot(structuredClone(params.snapshot));
  const { context, assertCurrent } = params;
  const getConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
  const gatewayOwner = context.resolveGatewayContext?.() ?? context;
  let references = 1;
  const signal = new AbortController();
  const revoke = (cause?: unknown) =>
    signal.abort(
      new Error("Restart recovery operator authority changed; start a new user turn.", { cause }),
    );
  const assertOwner = () => {
    if (references === 0) {
      throw new Error("Restart recovery operator authority is no longer active.");
    }
    signal.signal.throwIfAborted();
    params.signal?.throwIfAborted();
    assertCurrent();
  };
  const subscriptions: Array<() => void> = [];
  let identity: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  const releaseHold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (--references === 0) {
        subscriptions.splice(0).forEach((release) => release());
        identity?.release();
      }
    };
  };
  const release = releaseHold();
  try {
    assertOwner();
    const onAbort = () => revoke(params.signal?.reason);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    subscriptions.push(() => params.signal?.removeEventListener("abort", onAbort));
    const person = snapshot.devicePerson
      ? await prepareUserChannelIdentityAuthority({
          authorizationId: snapshot.devicePerson.id,
          policy: resolveUserChannelAuthorizationPolicy(getConfig().gateway),
        })
      : undefined;
    assertOwner();
    const assertPerson = () => {
      if (!snapshot.devicePerson) {
        return;
      }
      if (
        !snapshot.device ||
        snapshot.authPolicy.authMethod !== "device-token" ||
        !person?.isCurrent() ||
        person.linked.profileId !== snapshot.profileId ||
        person.linked.authorization?.subject !==
          userChannelIdentitySubject({
            channelId: "gateway",
            accountId: "paired-device",
            senderId: snapshot.device.deviceId,
          }) ||
        !isDeepStrictEqual(person.linked.authorization.grant, snapshot.grant)
      ) {
        throw new Error("Restart recovery device person binding changed; start a new user turn.");
      }
    };
    assertPerson();
    let pairingSource: ReturnType<typeof capturePublishedOperatorDeviceSource> | undefined;
    const generationOwner = context.sharedGatewaySessionGenerationState;
    if (snapshot.sharedGeneration !== undefined) {
      if (!generationOwner || generationOwner.requiredGeneration !== snapshot.sharedGeneration) {
        throw new Error("Restart recovery authentication owner changed; start a new user turn.");
      }
      subscriptions.push(
        generationOwner.onInvalidated(snapshot.sharedGeneration, revoke, snapshot.authPolicy),
      );
    }
    const device = captureGatewayDeviceRevocation(
      gatewayOwner,
      { deviceId: snapshot.device?.deviceId, role: "operator" },
      () => !signal.signal.aborted,
    );
    subscriptions.push(device.release);
    const releaseDeviceNotification = onGatewayDeviceSourceRevoked(device.isCurrent, revoke);
    if (releaseDeviceNotification) {
      subscriptions.push(releaseDeviceNotification);
    }
    const assertSourcePolicy = () => {
      assertOwner();
      assertPerson();
      pairingSource?.assertCurrent();
      const cfg = getConfig();
      const role = resolveOperatorRolePolicyForAssignment(
        snapshot.profileId,
        snapshot.assignedRole,
        cfg,
        snapshot.githubLogin,
      );
      if (
        !device.isCurrent() ||
        !isDeepStrictEqual(sourceRolePolicy(role), snapshot.rolePolicy) ||
        !isGatewayAuthGrantCurrent(snapshot.authPolicy, cfg) ||
        (snapshot.sharedGeneration !== undefined &&
          context.sharedGatewaySessionGenerationState !== generationOwner)
      ) {
        throw new Error("Restart recovery operator source policy changed.");
      }
      return cfg;
    };
    let assertPolicy = assertSourcePolicy;
    const recheck = () => {
      if (references > 0 && !signal.signal.aborted) {
        try {
          assertPolicy();
        } catch (error) {
          revoke(error);
        }
      }
    };
    // Subscribe before preparation yields: a committed downgrade remains revoked
    // even if another update restores the same role or authentication policy.
    subscriptions.push(
      onOperatorRolePolicyChanged((change) => {
        if (change.kind === "assignment" && change.profileId === snapshot.profileId) {
          revoke();
        } else if (change.kind === "config" && change.context === gatewayOwner) {
          recheck();
        }
      }),
    );
    assertSourcePolicy();
    identity = await prepareUserProfileIdentity(snapshot.profileId);
    const profileIdentity = identity;
    const assertFacts = () => {
      const cfg = assertSourcePolicy();
      const profile = profileIdentity.readCurrentFacts(snapshot.aliasBindingIds).profile;
      if (
        profile.profileId !== snapshot.profileId ||
        profile.assignedRole !== snapshot.assignedRole ||
        (profile.githubLogin ?? null) !== snapshot.githubLogin
      ) {
        throw new Error("Restart recovery operator identity changed.");
      }
      return { cfg, profile };
    };
    let accessAuthority: ReturnType<typeof resumeGatewayOperatorAccessGrant>;
    assertPolicy = () => {
      try {
        const { profile, cfg } = assertFacts();
        const access = resumeGatewayOperatorAccessGrant(profile, cfg, snapshot.grant);
        if (access && !accessAuthority) {
          accessAuthority = access;
          const onAccessAbort = () => revoke(access.signal.reason);
          access.signal.addEventListener("abort", onAccessAbort, { once: true });
          subscriptions.push(() => access.signal.removeEventListener("abort", onAccessAbort));
        }
        // Retain the first exact resumed owner before recovery yields. Later
        // policy checks cannot replace a revoked source with a fresh authority.
        accessAuthority?.signal.throwIfAborted();
        accessAuthority?.assertCurrent();
        accessAuthority?.signal.throwIfAborted();
        // A policy callback can change committed identity/config synchronously.
        return assertFacts().cfg;
      } catch (error) {
        revoke(error);
        throw error;
      }
    };
    subscriptions.push(onUserProfilesChanged(recheck));
    assertPolicy();
    if (snapshot.device) {
      const paired = await loadPairedDevicePairingStoreRecordReadOnly(snapshot.device.deviceId);
      if (
        !isPairedDeviceTokenIdentityCurrent(paired, "operator", snapshot.device, snapshot.scopes)
      ) {
        revoke();
      }
      assertPolicy();
      pairingSource = capturePublishedOperatorDeviceSource(
        snapshot.device,
        snapshot.scopes,
        revoke,
      );
      subscriptions.push(pairingSource.release);
    }
    assertPolicy();
    return Object.freeze({
      profileId: snapshot.profileId,
      assertCurrent: () => {
        assertPolicy();
      },
      signal: signal.signal,
      retain: () => {
        assertPolicy();
        references += 1;
        return releaseHold();
      },
      release,
    });
  } catch (error) {
    release();
    throw error;
  }
}
