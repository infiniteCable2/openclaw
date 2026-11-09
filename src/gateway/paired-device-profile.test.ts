import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommandSenderAuthority } from "../auto-reply/command-sender-authority.js";
import type { PairedDeviceTokenIdentity } from "../infra/device-pairing-core.types.js";
import {
  attachGatewayPairedDeviceProfileBinding,
  prepareGatewayPairedDeviceProfileBinding,
  prepareGatewayPairedDeviceProfileAuthorization,
  readGatewayPairedDeviceProfileBinding,
  transferGatewayPairedDeviceProfileBinding,
} from "./paired-device-profile.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  authorize: vi.fn(),
  capture: vi.fn(),
  subscribe: vi.fn(),
}));

// mock-isolation: Keep state workers outside the credential/link lifetime fixture.
vi.mock("../state/user-channel-identity-operations.js", () => ({
  prepareUserChannelIdentityAuthority: mocks.prepare,
  authorizeCanonicalUserChannelIdentity: mocks.authorize,
}));
// mock-isolation: Durable state machinery stays outside the link lifetime fixture.
vi.mock("../state/user-channel-identities.js", () => ({
  resolveUserChannelAuthorizationPolicy: () => ({ roles: null, identityScopes: null }),
  userChannelIdentitySubject: (identity: {
    channelId: string;
    accountId: string;
    senderId: string;
  }) => JSON.stringify([identity.channelId, identity.accountId, identity.senderId]),
}));
// mock-isolation: The fixture owns the accepted publication generation and invalidation signal.
vi.mock("../infra/device-pairing-publication.js", () => ({
  capturePublishedOperatorDeviceSource: mocks.capture,
}));
// mock-isolation: Use explicit profile publication rather than a process-global state owner.
vi.mock("../state/user-profile-events.js", () => ({ onUserProfilesChanged: mocks.subscribe }));

describe("paired operator person binding", () => {
  const credential: PairedDeviceTokenIdentity = {
    deviceId: "signed-device",
    key: "accepted-generation",
  };
  const scopes = ["operator.read", "operator.talk"];
  let linked: boolean;
  let credentialCurrent: boolean;
  let approvedScopes: readonly string[];
  let publishProfile: () => void;
  let revokeCredential: () => void;
  let releaseSource: ReturnType<typeof vi.fn>;
  let releaseProfile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    linked = true;
    credentialCurrent = true;
    approvedScopes = [...scopes];
    releaseSource = vi.fn();
    releaseProfile = vi.fn();
    mocks.prepare.mockResolvedValue({
      linked: { profileId: "person-a" },
      isCurrent: () => linked,
    });
    mocks.capture.mockImplementation((_identity, requestedScopes: readonly string[], notify) => {
      revokeCredential = notify;
      return {
        assertCurrent: () => {
          if (!credentialCurrent) {
            throw new Error("credential retired");
          }
          if (requestedScopes.some((scope) => !approvedScopes.includes(scope))) {
            throw new Error("scopes retired");
          }
        },
        release: releaseSource,
      };
    });
    mocks.subscribe.mockImplementation((notify) => {
      publishProfile = notify;
      return releaseProfile;
    });
  });

  it("binds only the accepted signed identity without widening scopes or inventing a login", async () => {
    const assertAdmission = vi.fn();
    const binding = await prepareGatewayPairedDeviceProfileBinding(
      credential,
      scopes,
      assertAdmission,
    );
    expect(mocks.prepare).toHaveBeenCalledWith({
      channelId: "gateway",
      accountId: "paired-device",
      senderId: "signed-device",
    });
    expect(mocks.capture).toHaveBeenCalledWith(credential, scopes, expect.any(Function));
    expect(binding).toBeDefined();
    const client = attachGatewayPairedDeviceProfileBinding({ connect: { scopes } }, binding!);
    expect(client).not.toHaveProperty("authenticatedUserId");
    expect(client.connect.scopes).toEqual(scopes);
    expect(getCommandSenderAuthority(client)?.()).toBe("person-a");
    expect(readGatewayPairedDeviceProfileBinding(client)).toBe(binding);
    expect(readGatewayPairedDeviceProfileBinding({ ...client })).toBe(binding);
    const principal = {};
    transferGatewayPairedDeviceProfileBinding(client, principal);
    expect(readGatewayPairedDeviceProfileBinding(principal)).toBe(binding);
    expect(getCommandSenderAuthority(principal)?.()).toBe("person-a");
    expect(assertAdmission).toHaveBeenCalledTimes(2);
  });

  it("does not enroll an unlinked credential", async () => {
    mocks.prepare.mockResolvedValue(undefined);
    expect(
      await prepareGatewayPairedDeviceProfileBinding(credential, scopes, () => {}),
    ).toBeUndefined();
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(releaseSource).toHaveBeenCalledOnce();
    expect(releaseProfile).toHaveBeenCalledOnce();
  });

  it("retains one native durable link authorization for the original access grant", async () => {
    const binding = await prepareGatewayPairedDeviceProfileBinding(credential, scopes, () => {});
    if (!binding) {
      throw new Error("expected linked binding");
    }
    const grant = { pluginId: "test-access", grantId: "11111111-1111-4111-8111-111111111111" };
    const reference = { version: 1, id: "22222222-2222-4222-8222-222222222222" };
    const accessCheck = vi.fn();
    const client = attachGatewayPairedDeviceProfileBinding(
      {
        internal: {
          operatorAccessAuthority: {
            ...binding.authority,
            gatewayAccessGrant: grant,
            assertCurrent: accessCheck,
          },
        },
      },
      binding,
    );
    mocks.authorize.mockResolvedValue(reference);
    await prepareGatewayPairedDeviceProfileAuthorization(client, {}, () => {});
    await prepareGatewayPairedDeviceProfileAuthorization(client, {}, () => {});
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(mocks.authorize).toHaveBeenCalledWith(
      {
        action: "authorize",
        identity: binding.identity,
        profileId: "person-a",
        policy: { roles: null, identityScopes: null },
        grant,
      },
      { assertCurrent: expect.any(Function) },
    );
    expect(binding.authorization).toEqual({
      reference,
      subject: '["gateway","paired-device","signed-device"]',
      grant,
    });
    const inputGuard = mocks.authorize.mock.calls[0]![1].assertCurrent;
    linked = false;
    expect(() => inputGuard()).toThrow();
  });

  it("keeps live policy authority without inventing a recoverable grant", async () => {
    const binding = await prepareGatewayPairedDeviceProfileBinding(credential, scopes, () => {});
    if (!binding) {
      throw new Error("expected linked binding");
    }
    const policyCheck = vi.fn();
    const client = attachGatewayPairedDeviceProfileBinding(
      {
        internal: {
          operatorAccessAuthority: {
            signal: new AbortController().signal,
            assertCurrent: policyCheck,
          },
        },
      },
      binding,
    );
    await prepareGatewayPairedDeviceProfileAuthorization(client, {}, () => {});
    expect(policyCheck).toHaveBeenCalledOnce();
    expect(binding.isCurrent()).toBe(true);
    expect(binding.authorization).toBeUndefined();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(getCommandSenderAuthority(client)?.()).toBe("person-a");
  });

  it.each(["token", "scopes"] as const)(
    "cannot revive %s authority changed while person lookup yielded",
    async (change) => {
      const result = { linked: { profileId: "person-a" }, isCurrent: () => linked };
      const lookup = Promise.withResolvers<typeof result>();
      mocks.prepare.mockReturnValue(lookup.promise);
      const pending = prepareGatewayPairedDeviceProfileBinding(credential, scopes, () => {});
      expect(mocks.capture).toHaveBeenCalledOnce();
      expect(mocks.prepare).toHaveBeenCalledOnce();
      if (change === "token") {
        credentialCurrent = false;
      } else {
        approvedScopes = ["operator.read"];
      }
      revokeCredential();
      credentialCurrent = true;
      approvedScopes = [...scopes];
      lookup.resolve(result);
      await expect(pending).rejects.toThrow(/retired/);
      expect(releaseSource).toHaveBeenCalledOnce();
      expect(releaseProfile).toHaveBeenCalledOnce();
    },
  );

  it.each(["profile", "credential"])(
    "keeps %s revocation irreversible for accepted work",
    async (kind) => {
      const binding = await prepareGatewayPairedDeviceProfileBinding(credential, scopes, () => {});
      expect(binding).toBeDefined();
      const client = attachGatewayPairedDeviceProfileBinding({}, binding!);
      const retained = binding!.authority;
      if (kind === "profile") {
        linked = false;
        publishProfile();
        linked = true;
      } else {
        credentialCurrent = false;
        revokeCredential();
        credentialCurrent = true;
      }
      expect(retained.signal.aborted).toBe(true);
      expect(() => retained.assertCurrent()).toThrow();
      expect(binding!.isCurrent()).toBe(false);
      expect(getCommandSenderAuthority(client)?.()).toBeUndefined();
      expect(releaseSource).toHaveBeenCalled();
      expect(releaseProfile).toHaveBeenCalled();
    },
  );

  it("rechecks original admission after async identity preparation", async () => {
    const assertAdmission = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("admission retired");
      });
    await expect(
      prepareGatewayPairedDeviceProfileBinding(credential, scopes, assertAdmission),
    ).rejects.toThrow("admission retired");
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(releaseSource).toHaveBeenCalledOnce();
  });

  it("refuses a credential rotated while identity preparation yielded", async () => {
    credentialCurrent = false;
    await expect(
      prepareGatewayPairedDeviceProfileBinding(credential, scopes, () => {}),
    ).rejects.toThrow("credential retired");
    expect(releaseSource).toHaveBeenCalledOnce();
    expect(releaseProfile).toHaveBeenCalledOnce();
  });
});
