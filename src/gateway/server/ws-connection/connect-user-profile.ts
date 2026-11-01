import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../../config/io.js";
import type { PairedDeviceTokenIdentity } from "../../../infra/device-pairing-identity.js";
import { resolveHostAccountName } from "../../../infra/host-account-name.js";
import { prepareUserProfileRoleAuthority } from "../../../state/user-channel-identity-operations.js";
import { prepareUserProfileCatalog } from "../../../state/user-profile-list.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForTailscaleIdentity,
} from "../../../state/user-profile-writes.js";
import { classifyTailscaleLogin } from "../../../state/user-profiles-tailscale-login.js";
import { prepareGatewayRecipientProfile } from "../../expected-profile.js";
import { shouldUseGatewayOwnerProfile } from "../../gateway-owner-profile.js";
import { createAuthenticatedGitHubIdentitySync } from "../../github-user-identity.js";
import {
  attachGatewayLocalUserIngress,
  type prepareGatewayLocalUserIngress,
} from "../../local-user-ingress.js";
import { hasGatewayOperatorAccessPolicies } from "../../operator-access-policy.js";
import {
  prepareGatewayPairedDeviceProfileBinding,
  type GatewayPairedDeviceProfileBinding,
} from "../../paired-device-profile.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../../server-constants.js";
import { formatForLog } from "../../ws-log.js";
import type { GatewayWsClient } from "../ws-types.js";
import {
  rejectUnavailableProfileConnect,
  resolveGatewayConnectPolicyFailure,
} from "./connect-admission.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

type PreparedConnectProfile = Awaited<ReturnType<typeof resolveAuthenticatedProfile>> & {
  deviceBinding?: GatewayPairedDeviceProfileBinding;
};

/** The profile owner prepares identity, admission and its one retained connection lifecycle. */
export async function prepareGatewayConnectProfile(params: {
  context: GatewayConnectPhaseContext;
  state: DeviceAuthorizedGatewayConnect;
  deviceSource: PairedDeviceTokenIdentity | null;
  shouldTrackPresence: boolean;
}) {
  const { context, state, deviceSource, shouldTrackPresence } = params;
  const { authResult, role, authMethod, scopes: deviceScopes } = state;
  const authenticatedUserId = normalizeOptionalString(authResult.user);
  const tailscaleLogin = authResult.tailscaleIdentity
    ? classifyTailscaleLogin(authResult.tailscaleIdentity.login)
    : undefined;
  const authenticatedUserIsTailscaleProvider = tailscaleLogin?.kind === "provider";
  const profileLifecycle = createGatewayConnectProfileLifecycle(context, state);
  const resolveAuthenticatedGitHubIdentity = createAuthenticatedGitHubIdentitySync({
    authResult,
    authConfig: context.configSnapshot.gateway?.auth,
    requestHeaders: context.handler.upgradeReq.headers,
    assertCurrent: profileLifecycle.assertCurrent,
  });
  const rolesConfigured = Boolean(context.configSnapshot.gateway?.roles);
  const sharedSecretOperatorOwner =
    role === "operator" && (authMethod === "token" || authMethod === "password");
  // Synthetic callers bypass WS admission; ephemeral control-plane clients stay unprofiled.
  const ownerProfileExpected =
    shouldTrackPresence &&
    shouldUseGatewayOwnerProfile({ role, authenticatedUserId, authMethod, rolesConfigured });
  const profileAdmission = await resolveGatewayConnectProfileAdmission({
    context,
    state,
    ownerProfileExpected,
    authenticatedUserId,
    deviceSource,
    deviceScopes,
    resolveAuthenticatedGitHubIdentity,
    assertCurrent: profileLifecycle.assertCurrent,
  });
  if (!profileAdmission.ok) {
    return { ok: false as const };
  }
  const preparedProfile = profileAdmission.prepared;
  return {
    ok: true as const,
    authenticatedUserId,
    authenticatedUserIsTailscaleProvider,
    profileLifecycle,
    resolveAuthenticatedGitHubIdentity,
    sharedSecretOperatorOwner,
    ownerProfileExpected,
    preparedProfile,
    authenticatedUserProfile: preparedProfile?.profile,
  };
}

/** One connection retains its profile authority through admission and later identity refreshes. */
export function createGatewayConnectProfileLifecycle(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
) {
  const { handler } = context;
  let client: GatewayWsClient | undefined;
  const rolesCurrent = () =>
    isDeepStrictEqual(context.configSnapshot.gateway?.roles, getRuntimeConfig().gateway?.roles);
  const clientCurrent = () =>
    !handler.isClosed() &&
    handler.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
    (!client || (handler.getClient() === client && !client.invalidated));
  const assertCurrent = () => {
    handler.connectionWork.signal.throwIfAborted();
    if (!clientCurrent() || resolveGatewayConnectPolicyFailure(context, state) || !rolesCurrent()) {
      throw new Error("Gateway profile acquisition authority expired");
    }
  };
  return {
    assertCurrent,
    isCurrent: (prepared: PreparedConnectProfile | undefined) =>
      (!prepared ||
        (prepared.authority.isCurrent() && prepared.deviceBinding?.isCurrent() !== false)) &&
      rolesCurrent(),
    bind: (registered: GatewayWsClient) => {
      client = registered;
    },
    async attach(
      profileId: string,
      updatedAt: number,
      prepareIngress: (
        profile: PreparedConnectProfile["profile"],
      ) => ReturnType<typeof prepareGatewayLocalUserIngress>,
    ) {
      if (!client || !clientCurrent()) {
        return;
      }
      const registered = client;
      assertCurrent();
      const prepared = await resolveAuthenticatedProfile(profileId, updatedAt, assertCurrent);
      assertCurrent();
      if (client !== registered || !prepared.authority.isCurrent()) {
        throw new Error("Gateway profile changed before attachment");
      }
      const { profile } = prepared;
      registered.preparedRecipientProfileId = undefined;
      if (registered.authenticatedUserProfile) {
        Object.assign(registered.authenticatedUserProfile, profile);
      } else {
        registered.authenticatedUserProfile = profile;
      }
      prepareGatewayRecipientProfile(registered, { identity: prepared.recipient });
      attachGatewayLocalUserIngress(registered, prepareIngress(profile));
      const { profileId: id, ...display } = profile;
      handler.buildRequestContext().refreshConnectedUserProfile?.({ id, ...display });
    },
  };
}

async function resolveAuthenticatedProfile(
  profileId: string,
  updatedAt: number,
  assertCurrent?: () => void,
) {
  assertCurrent?.();
  if (hasGatewayOperatorAccessPolicies(getRuntimeConfig())) {
    (await prepareUserProfileCatalog()).release();
    assertCurrent?.();
  }
  const authority = await prepareUserProfileRoleAuthority(profileId);
  assertCurrent?.();
  if (!authority?.isCurrent()) {
    throw new Error("Gateway profile changed during acquisition");
  }
  const { id, displayName, avatarRevision, hasAvatar } = authority.display;
  return {
    profile: { profileId: id, displayName, avatarRevision, hasAvatar, updatedAt },
    authority,
    recipient: {
      profileId: authority.profileId,
      role: authority.role,
      githubLogin: authority.githubLogin ?? null,
      aliases: new Set(authority.aliases),
    },
  };
}

/** Role and access policies need verified identity before admission; attribution alone may defer it. */
export async function resolveGatewayConnectProfileAdmission(params: {
  context: Pick<GatewayConnectPhaseContext, "configSnapshot"> &
    Parameters<typeof rejectUnavailableProfileConnect>[0] & {
      handler: Pick<GatewayConnectPhaseContext["handler"], "connId" | "logWsControl">;
    };
  state: Pick<DeviceAuthorizedGatewayConnect, "authResult" | "role" | "authMethod">;
  ownerProfileExpected: boolean;
  authenticatedUserId: string | undefined;
  deviceSource?: PairedDeviceTokenIdentity | null;
  deviceScopes?: readonly string[];
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
  assertCurrent?: () => void;
}): Promise<{ ok: true; prepared?: PreparedConnectProfile } | { ok: false }> {
  const { context, state, ownerProfileExpected, authenticatedUserId } = params;
  const profileRequired =
    Boolean(context.configSnapshot.gateway?.roles) ||
    hasGatewayOperatorAccessPolicies(context.configSnapshot);
  try {
    params.assertCurrent?.();
    const deviceBinding =
      state.role === "operator" &&
      state.authMethod === "device-token" &&
      !authenticatedUserId &&
      params.deviceSource
        ? await prepareGatewayPairedDeviceProfileBinding(
            params.deviceSource,
            params.deviceScopes ?? [],
            () => params.assertCurrent?.(),
          )
        : undefined;
    params.assertCurrent?.();
    if (deviceBinding) {
      const prepared = await resolveAuthenticatedProfile(
        deviceBinding.profileId,
        Date.now(),
        () => {
          params.assertCurrent?.();
          deviceBinding.authority.assertCurrent();
        },
      );
      deviceBinding.authority.assertCurrent();
      return { ok: true, prepared: { ...prepared, deviceBinding } };
    }
    if (
      !ownerProfileExpected &&
      !authenticatedUserId &&
      profileRequired &&
      state.role === "operator"
    ) {
      const message =
        "operator role policies require a verified user identity for this authentication method; reconnect through the trusted proxy or Tailscale, or use the shared gateway token/password";
      context.markHandshakeFailure("authenticated-profile-unavailable");
      context.sendHandshakeErrorResponse(ErrorCodes.NOT_PAIRED, message, {
        details: { code: ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED },
      });
      await context.releasePendingNodePairingCleanup();
      context.handler.close(1008, message);
      return { ok: false };
    }
    if (
      !ownerProfileExpected &&
      (!authenticatedUserId || (params.resolveAuthenticatedGitHubIdentity && !profileRequired))
    ) {
      return { ok: true };
    }
    const options = { assertCurrent: params.assertCurrent };
    const ownerDisplayName = ownerProfileExpected ? await resolveHostAccountName() : undefined;
    params.assertCurrent?.();
    const profile = ownerProfileExpected
      ? await ensureCanonicalGatewayOwnerProfile(ownerDisplayName ?? null, options)
      : params.resolveAuthenticatedGitHubIdentity
        ? await params.resolveAuthenticatedGitHubIdentity()
        : state.authResult.tailscaleIdentity
          ? await ensureCanonicalUserProfileForTailscaleIdentity(
              state.authResult.tailscaleIdentity,
              options,
            )
          : await ensureCanonicalUserProfileForEmail(authenticatedUserId!, options);
    params.assertCurrent?.();
    const prepared = await resolveAuthenticatedProfile(
      "profileId" in profile ? profile.profileId : profile.id,
      profile.updatedAt,
      params.assertCurrent,
    );
    params.assertCurrent?.();
    if (!prepared.authority.isCurrent()) {
      throw new Error("Gateway profile changed during acquisition");
    }
    return { ok: true, prepared };
  } catch (error) {
    context.handler.logWsControl.warn(
      `user profile resolution failed conn=${context.handler.connId} user=${formatForLog(authenticatedUserId)}: ${formatForLog(error)}`,
    );
    if (
      state.role === "operator" &&
      ((state.authMethod === "device-token" && params.deviceSource) ||
        (!ownerProfileExpected &&
          profileRequired &&
          state.authMethod !== "token" &&
          state.authMethod !== "password"))
    ) {
      await rejectUnavailableProfileConnect(context, error);
      return { ok: false };
    }
    return { ok: true };
  }
}
