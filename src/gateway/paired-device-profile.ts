import { withCommandSenderAuthority } from "../auto-reply/command-sender-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PairedDeviceTokenIdentity } from "../infra/device-pairing-core.types.js";
import { capturePublishedOperatorDeviceSource } from "../infra/device-pairing-publication.js";
import {
  resolveUserChannelAuthorizationPolicy,
  userChannelIdentitySubject,
} from "../state/user-channel-identities.js";
import {
  authorizeCanonicalUserChannelIdentity,
  prepareUserChannelIdentityAuthority,
} from "../state/user-channel-identity-operations.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import type {
  UserChannelAuthorization,
  UserChannelAuthorizationReference,
  UserChannelIdentity,
} from "../state/user-profiles.types.js";
import type { GatewayOperatorAccessAuthority } from "./operator-access-policy.types.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type PairedDeviceProfileAuthorization = Readonly<{
  reference: UserChannelAuthorizationReference;
  subject: string;
  grant: UserChannelAuthorization["grant"];
}>;

export type GatewayPairedDeviceProfileBinding = Readonly<{
  identity: UserChannelIdentity;
  profileId: string;
  isCurrent: () => boolean;
  authority: GatewayOperatorAccessAuthority;
  authorization?: PairedDeviceProfileAuthorization;
}>;

const DEVICE_PROFILE_BINDING = Symbol("openclaw.pairedDeviceProfileBinding");
type BindingOwner = { [DEVICE_PROFILE_BINDING]?: GatewayPairedDeviceProfileBinding };
const authorizations = new WeakMap<
  GatewayPairedDeviceProfileBinding,
  PairedDeviceProfileAuthorization
>();
const cleanup = new FinalizationRegistry<() => void>((release) => release());

/** A separate scope prevents finalizer cleanup from retaining its check target. */
function watchPairedDeviceProfile(
  credential: PairedDeviceTokenIdentity,
  scopes: readonly string[],
  reference: WeakRef<() => void>,
) {
  const recheck = () => {
    try {
      reference.deref()?.();
    } catch {
      // The original check publishes irreversible revocation before throwing.
    }
  };
  const source = capturePublishedOperatorDeviceSource(credential, scopes, recheck);
  try {
    const releaseProfile = onUserProfilesChanged(recheck);
    let released = false;
    return {
      assertCurrent: source.assertCurrent,
      release: () => {
        if (!released) {
          released = true;
          source.release();
          releaseProfile();
        }
      },
    };
  } catch (error) {
    source.release();
    throw error;
  }
}

/** A person link qualifies an already accepted signed credential; it never authenticates one. */
export async function prepareGatewayPairedDeviceProfileBinding(
  credential: PairedDeviceTokenIdentity,
  scopes: readonly string[],
  assertCurrent: () => void,
): Promise<GatewayPairedDeviceProfileBinding | undefined> {
  assertCurrent();
  const identity = Object.freeze({
    channelId: "gateway",
    accountId: "paired-device",
    senderId: credential.deviceId,
  });
  let linked: Awaited<ReturnType<typeof prepareUserChannelIdentityAuthority>>;
  const invalidated = new AbortController();
  let watcher: ReturnType<typeof watchPairedDeviceProfile> | undefined;
  const check = () => {
    try {
      invalidated.signal.throwIfAborted();
      watcher?.assertCurrent();
      if (linked && !linked.isCurrent()) {
        throw new Error("Paired device person binding changed; reconnect before continuing.");
      }
    } catch (error) {
      invalidated.abort(error);
      watcher?.release();
      throw error;
    }
  };
  try {
    // Observe this exact credential before any worker lookup can yield. A
    // revoke-and-restore while preparing the person cannot revive admission.
    watcher = watchPairedDeviceProfile(credential, scopes, new WeakRef(check));
    linked = await prepareUserChannelIdentityAuthority(identity);
    assertCurrent();
    check();
    if (!linked) {
      watcher.release();
      return undefined;
    }
    check();
    cleanup.register(check, watcher.release);
    const binding: GatewayPairedDeviceProfileBinding = Object.freeze({
      identity,
      profileId: linked.linked.profileId,
      isCurrent: () => {
        try {
          check();
          return true;
        } catch {
          return false;
        }
      },
      authority: { assertCurrent: check, signal: invalidated.signal },
      get authorization() {
        return authorizations.get(binding);
      },
    });
    return binding;
  } catch (error) {
    watcher?.release();
    throw error;
  }
}

/** Retain server-prepared person authority without manufacturing a login identity. */
export function attachGatewayPairedDeviceProfileBinding<T extends object>(
  client: T,
  binding: GatewayPairedDeviceProfileBinding,
): T {
  binding.authority.assertCurrent();
  const sender = withCommandSenderAuthority({}, () =>
    binding.isCurrent() ? binding.profileId : undefined,
  );
  return Object.assign(client, sender, { [DEVICE_PROFILE_BINDING]: binding });
}

/** Named transport snapshots retain the original person source, never resolve a successor. */
export function transferGatewayPairedDeviceProfileBinding(source: object, target: object): void {
  const binding = readGatewayPairedDeviceProfileBinding(source);
  if (binding) {
    attachGatewayPairedDeviceProfileBinding(target, binding);
  }
}

export function readGatewayPairedDeviceProfileBinding(
  client: object | null | undefined,
): GatewayPairedDeviceProfileBinding | undefined {
  // SAFETY: Only the admission owner attaches this module-private symbol.
  return (client as BindingOwner | null | undefined)?.[DEVICE_PROFILE_BINDING];
}

/** Reuse native durable authorization once the original connection access grant is known. */
export async function prepareGatewayPairedDeviceProfileAuthorization(
  client: Pick<GatewayWsClient, "internal">,
  config: OpenClawConfig,
  assertAdmission: () => void,
): Promise<void> {
  const binding = readGatewayPairedDeviceProfileBinding(client);
  if (!binding || binding.authorization) {
    return;
  }
  const access = client.internal?.operatorAccessAuthority;
  const grant = access ? access.gatewayAccessGrant : null;
  const assertCurrent = () => {
    assertAdmission();
    binding.authority.assertCurrent();
    access?.assertCurrent();
  };
  assertCurrent();
  // An existing policy owner may deliberately be nonrecoverable. Unknown is
  // not the explicit no-policy grant, although live requests remain allowed.
  if (grant === undefined) {
    return;
  }
  const reference = await authorizeCanonicalUserChannelIdentity(
    {
      action: "authorize",
      identity: binding.identity,
      profileId: binding.profileId,
      policy: resolveUserChannelAuthorizationPolicy(config.gateway),
      grant,
    },
    { assertCurrent },
  );
  assertCurrent();
  if (!reference) {
    throw new Error("Paired device person authorization changed; reconnect before continuing.");
  }
  authorizations.set(
    binding,
    Object.freeze({ reference, subject: userChannelIdentitySubject(binding.identity), grant }),
  );
}
