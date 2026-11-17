import { expectDefined } from "@openclaw/normalization-core";
import type { DevicePairSetupCodeResult } from "../../packages/gateway-protocol/src/schema/devices.js";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import type {
  UsersCreateResult,
  UsersLinkChannelIdentityResult,
  UsersSelfResult,
  UsersSetRoleResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayClient, GatewayClientOptions } from "../../src/gateway/client.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { decodePairingSetupCode } from "../../src/pairing/setup-code.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import { setUserProfileRole } from "../../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { VERSION } from "../../src/version.js";
import {
  BRANCH_GATEWAY_ORIGIN,
  BRANCH_GATEWAY_SCOPES,
  connectConversationOperator,
} from "./conversation-branches-gateway.js";
import { acquireGatewayTestClient } from "./gateway-client.js";
import type { OpenClawTestInstance } from "./openclaw-test-instance.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

/** Setup authority is separate from the measured person's unchanged limited role. */
export function configurePairedConversationLoad(config: OpenClawConfig): void {
  const gateway = expectDefined(config.gateway, "load Gateway configuration");
  expectDefined(gateway.roles, "load roles").definitions.provisioner = {
    sessions: { others: "view" },
    agents: "*",
    scopes: ["operator.admin"],
  };
  const approval = expectDefined(
    gateway.auth?.trustedProxy?.deviceAutoApprove,
    "load pairing policy",
  );
  approval.scopes = [...new Set([...(approval.scopes ?? []), "operator.admin"])];
}

/** Populate only the isolated fixture before its Gateway owns the state database. */
export async function preparePairedConversationLoadProfile(gateway: OpenClawTestInstance) {
  try {
    const profile = ensureProfileForEmail("load-provisioner@example.test", { env: gateway.env });
    setUserProfileRole(profile.id, "provisioner", { env: gateway.env });
  } finally {
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(gateway.env));
  }
}

/** Native setup-code handoff; no copied credentials, person snapshots, or pairing rows. */
export async function preparePairedConversationLoadOperator(params: {
  gateway: OpenClawTestInstance;
  signal: AbortSignal;
  verifyCleanup?: (cleanup: () => Promise<void>) => Promise<void>;
}) {
  const { gateway, signal } = params;
  const identity = loadOrCreateDeviceIdentity({
    path: gateway.state.statePath("conversation-load-paired-person", "credentials.sqlite"),
  });
  type ConnectionOptions = NonNullable<Parameters<typeof connectConversationOperator>[3]>;
  const open = async (options: GatewayClientOptions) => {
    const acquired: { client?: GatewayClient } = {};
    let hello: HelloOk | undefined;
    let failure: Error | undefined;
    let expectedClose = false;
    let stopping: Promise<void> | undefined;
    const stop = () => {
      expectedClose = true;
      if (!acquired.client) {
        return Promise.resolve();
      }
      return (stopping ??= acquired.client.stopAndWait());
    };
    const abort = () => {
      failure ??= new Error("Paired load connection canceled", { cause: signal.reason });
      void stop().catch(() => {}); // The retained original stop promise is joined by close.
    };
    const close = () => {
      expectedClose = true;
      signal.removeEventListener("abort", abort);
      return runQaGatewayFixture(async () => {
        if (failure) {
          throw failure;
        }
      }, stop);
    };
    const client = await acquireGatewayTestClient(
      {
        url: gateway.url,
        origin: BRANCH_GATEWAY_ORIGIN,
        env: gateway.env,
        deviceIdentity: identity,
        clientVersion: VERSION,
        requestTimeoutMs: 30_000,
        hostDeps: {
          loadDeviceAuthToken: () => null,
          storeDeviceAuthToken: () => {},
          clearDeviceAuthToken: () => {},
        },
        ...options,
        onHelloOk: (value) => {
          hello = value;
        },
        onClose: () => {
          if (!expectedClose) {
            failure ??= new Error("Paired load connection closed unexpectedly");
            void stop().catch(() => {});
          }
        },
      },
      {
        signal,
        verifyCleanup: params.verifyCleanup,
        timeoutMs: 30_000,
        timeoutMessage: "Paired load handshake timed out",
        closeMessage: "Paired load handshake closed",
      },
    );
    acquired.client = client;
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      if (failure) {
        throw failure;
      }
      return {
        hello: expectDefined(hello, "native paired load hello"),
        call: async <T = unknown>(
          method: string,
          value: unknown,
          request?: { timeoutMs: number },
        ) => {
          signal.throwIfAborted();
          if (failure) {
            throw failure;
          }
          return client.request<T>(method, value, request);
        },
        close,
      };
    } catch (error) {
      return await runQaGatewayFixture(async () => {
        throw error;
      }, close);
    }
  };
  const admin = await connectConversationOperator(
    gateway,
    "load-provisioner@example.test",
    signal,
    {
      scopes: ["operator.admin"],
    },
  );
  let bootstrap: Awaited<ReturnType<typeof open>> | undefined;
  return await runQaGatewayFixture(
    async () => {
      const setup = await admin.call<DevicePairSetupCodeResult>("device.pair.setupCode", {
        includeQr: false,
        bootstrapProfile: "limited",
        publicUrl: gateway.url,
      });
      bootstrap = await open({
        bootstrapToken: decodePairingSetupCode(setup.setupCode).bootstrapToken,
        preferBootstrapToken: true,
        role: "node",
        clientName: "node-host",
        mode: "node",
        scopes: [],
      });
      const deviceToken = expectDefined(
        bootstrap.hello.auth?.deviceTokens?.find((entry) => entry.role === "operator")?.deviceToken,
        "native paired load operator token",
      );
      const { profile } = await admin.call<UsersCreateResult>("users.create", {
        displayName: "Load person",
      });
      await admin.call<UsersSetRoleResult>("users.setRole", {
        profileId: profile.id,
        role: "limited",
      });
      await admin.call<UsersLinkChannelIdentityResult>("users.linkChannelIdentity", {
        profileId: profile.id,
        identity: { channelId: "gateway", accountId: "paired-device", senderId: identity.deviceId },
      });
      return async (options: ConnectionOptions = {}) => {
        const connected = await open({
          deviceToken,
          role: "operator",
          clientName: "openclaw-control-ui",
          mode: "webchat",
          platform: "web",
          scopes: options.scopes ?? BRANCH_GATEWAY_SCOPES,
          onEvent: (event) => options.onEvent?.(event.event, event.payload),
        });
        try {
          const self = await connected.call<UsersSelfResult>("users.self", {});
          if (self.profile.id !== profile.id || self.profile.role !== "limited") {
            throw new Error("Paired load person does not match its native link");
          }
          return { call: connected.call, close: connected.close };
        } catch (error) {
          return await runQaGatewayFixture(async () => {
            throw error;
          }, connected.close);
        }
      };
    },
    () => bootstrap?.close(),
    () => admin.close(),
  );
}
