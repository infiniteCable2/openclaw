import path from "node:path";
import { withRegisteredChannelIngress } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveAgentSpeechConversationRoute } from "openclaw/plugin-sdk/routing";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../channel.js";
import type { MatrixConfig } from "../types.js";
import * as routes from "./monitor/route.js";
import { createMatrixRtcConversationInputSource } from "./rtc-ingress.js";

const roomId = "!call:example.test";
const senderId = "@Alice:example.test";
const conversationId = "rtc-conversation";
const remoteMembership = {
  userId: senderId,
  deviceId: "CALLDEVICE",
  memberId: "call-member",
  rtcBackendIdentity: "call-backend",
};
const input = {
  agentId: "main",
  conversationId,
  inputId: "input-1",
  purpose: "user" as const,
};
const plugin: ChannelPlugin = {
  id: "matrix",
  meta: {
    id: "matrix",
    label: "Matrix test",
    selectionLabel: "Matrix test",
    docsPath: "/channels/matrix",
    blurb: "RTC ingress test",
  },
  capabilities: { chatTypes: ["direct"] },
  config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
  bindings: matrixPlugin.bindings,
};

async function withSource(
  run: (fixture: {
    cfg: OpenClawConfig;
    matrix: MatrixConfig;
    runtime: PluginRuntime;
    source: ReturnType<typeof createMatrixRtcConversationInputSource>;
    createSource: (
      overrides?: Partial<Parameters<typeof createMatrixRtcConversationInputSource>[0]>,
    ) => ReturnType<typeof createMatrixRtcConversationInputSource>;
    resolve: ReturnType<typeof vi.fn<PluginRuntime["channel"]["inbound"]["ingress"]["resolve"]>>;
    nativeResolve: PluginRuntime["channel"]["inbound"]["ingress"]["resolve"];
    dispatchSessionKey: string;
    admit: ReturnType<
      typeof vi.fn<
        NonNullable<PluginRuntime["channel"]["inbound"]["ingress"]["conversation"]>["admitInput"]
      >
    >;
    readStore: ReturnType<typeof vi.fn<PluginRuntime["channel"]["pairing"]["readAllowFromStore"]>>;
    endCall: () => void;
    retire: () => void;
  }) => Promise<void>,
) {
  await withTempHome(async () => {
    const matrix: MatrixConfig = {
      enabled: true,
      accounts: { default: {} },
      dm: { enabled: true, policy: "allowlist", allowFrom: [senderId] },
      rtc: {
        enabled: true,
        authServiceUrl: "https://rtc.example.test",
        mediaBridgeCommand: path.resolve("test-media-bridge"),
        transcriptionProvider: "test-stt",
        admissions: [{ roomId, userId: senderId, agentId: "main" }],
      },
    };
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { conversationMode: "branches" }, other: {} } },
      bindings: [{ agentId: "main", match: { channel: "matrix" } }],
      session: { dmScope: "per-channel-peer" },
      channels: { matrix },
    };
    await withRegisteredChannelIngress(
      { plugin, config: cfg, setRuntime() {} },
      async (native, retire) => {
        const conversation = native.channel.inbound.ingress.conversation;
        if (!conversation) {
          throw new Error("Registered host must provide conversation admission");
        }
        const nativeResolve = native.channel.inbound.ingress.resolve;
        const resolve = vi.fn(nativeResolve);
        const admit = vi.fn(conversation.admitInput);
        const readStore = vi.fn<PluginRuntime["channel"]["pairing"]["readAllowFromStore"]>(
          async () => [],
        );
        const runtime: PluginRuntime = {
          ...native,
          config: { ...native.config, current: () => cfg },
          channel: {
            ...native.channel,
            pairing: { ...native.channel.pairing, readAllowFromStore: readStore },
            inbound: {
              ...native.channel.inbound,
              ingress: {
                ...native.channel.inbound.ingress,
                resolve,
                conversation: { version: 1, admitInput: admit },
              },
            },
          },
        };
        const sourceSessionKey = routes.resolveMatrixInboundRoute({
          cfg,
          accountId: "default",
          roomId,
          senderId,
          isDirectMessage: true,
          resolveAgentRoute: runtime.channel.routing.resolveAgentRoute,
        }).route.sessionKey;
        const dispatchSessionKey = resolveAgentSpeechConversationRoute({
          cfg,
          agentId: "main",
          channel: "matrix",
          accountId: "default",
          sourceSessionKey,
          conversationId,
        }).sessionKey;
        let live = true;
        const createSource = (
          overrides: Partial<Parameters<typeof createMatrixRtcConversationInputSource>[0]> = {},
        ) =>
          createMatrixRtcConversationInputSource({
            runtime,
            runtimeEnv: { log() {}, error() {}, exit: vi.fn() },
            accountId: "default",
            roomId,
            agentId: "main",
            conversationId,
            sourceSessionKey,
            dispatchSessionKey: resolveAgentSpeechConversationRoute({
              cfg,
              agentId: overrides.agentId ?? "main",
              channel: "matrix",
              accountId: overrides.accountId ?? "default",
              sourceSessionKey: overrides.sourceSessionKey ?? sourceSessionKey,
              conversationId: overrides.conversationId ?? conversationId,
            }).sessionKey,
            remoteMembership,
            assertCurrent: () => {
              if (!live) {
                throw new Error("Original call ended");
              }
            },
            ...overrides,
          });
        await run({
          cfg,
          matrix,
          runtime,
          source: createSource(),
          createSource,
          resolve,
          nativeResolve,
          dispatchSessionKey,
          admit,
          readStore,
          endCall: () => {
            live = false;
          },
          retire,
        });
      },
    );
  });
}

afterEach(() => vi.restoreAllMocks());

describe("MatrixRTC text-free conversation admission", () => {
  it("admits each user, steering and greeting input through the original native owner", async () => {
    await withSource(async ({ source, resolve, admit, readStore, dispatchSessionKey }) => {
      const admissions = [];
      for (const purpose of ["user", "steering", "greeting"] as const) {
        admissions.push(await source.admitInput({ ...input, inputId: purpose, purpose }));
      }
      expect(new Set(admissions).size).toBe(3);
      expect(admissions[0]).toMatchObject({ version: 1, kind: "conversation-input-admission" });
      expect(resolve).toHaveBeenCalledTimes(3);
      expect(readStore).not.toHaveBeenCalled();
      const last = resolve.mock.calls.at(-1)?.[0];
      expect(last).toMatchObject({
        channelId: "matrix",
        accountId: "default",
        subject: { stableId: senderId },
        conversation: { kind: "direct", id: roomId },
        event: { kind: "conversation", authMode: "inbound", mayPair: false },
        contextBinding: {
          agentId: "main",
          sessionKey: dispatchSessionKey,
          messageId: "greeting",
          nativeChannelId: roomId,
          inboundEventKind: "user_request",
        },
      });
      expect(last?.identity.primary.authentication).toBe("verified");
      expect(admit.mock.calls.at(-1)?.[0]).toMatchObject({
        input: { ...input, inputId: "greeting", purpose: "greeting" },
        scope: { rawPrincipalRef: senderId, conversation: { kind: "direct", id: roomId } },
      });
    });
  });

  it("fails closed on an older policy-only runtime without attempting ingress", async () => {
    await withSource(async ({ runtime, createSource, resolve }) => {
      runtime.channel.inbound.ingress.conversation = undefined;
      await expect(createSource().admitInput(input)).rejects.toThrow("version 1");
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it("rejects a different conversation or agent before resolving sender policy", async () => {
    await withSource(async ({ source, resolve }) => {
      await expect(source.admitInput({ ...input, conversationId: "another-call" })).rejects.toThrow(
        "call binding",
      );
      await expect(source.admitInput({ ...input, agentId: "other" })).rejects.toThrow(
        "call binding",
      );
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it("uses live account allowlist overrides rather than the base account grant", async () => {
    await withSource(async ({ matrix, source, resolve }) => {
      matrix.accounts = { default: { dm: { policy: "allowlist", allowFrom: [] } } };
      await expect(source.admitInput(input)).rejects.toThrow();
      expect(resolve.mock.calls.at(-1)?.[0].allowFrom).toEqual([]);
    });
  });

  it("rejects an absent named account before input or provider acquisition", async () => {
    await withSource(async ({ createSource, resolve, admit }) => {
      expect(() => createSource({ accountId: "removed-fixture-account" })).toThrow(
        "account is no longer available",
      );
      expect(resolve).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    });
  });

  it("does not let a removed named account inherit the base RTC grant", async () => {
    await withSource(async ({ createSource, matrix, cfg, runtime, resolve, admit }) => {
      matrix.accounts = { default: {}, "call-fixture-account": {} };
      cfg.bindings = [
        ...(cfg.bindings ?? []),
        { agentId: "main", match: { channel: "matrix", accountId: "call-fixture-account" } },
      ];
      const sourceSessionKey = routes.resolveMatrixInboundRoute({
        cfg,
        accountId: "call-fixture-account",
        roomId,
        senderId,
        isDirectMessage: true,
        resolveAgentRoute: runtime.channel.routing.resolveAgentRoute,
      }).route.sessionKey;
      const source = createSource({ accountId: "call-fixture-account", sourceSessionKey });
      delete matrix.accounts["call-fixture-account"];
      await expect(source.admitInput(input)).rejects.toThrow("account is no longer available");
      expect(resolve).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    });
  });

  it("retains the native implicit default account with usable cached-auth configuration", async () => {
    await withSource(async ({ createSource, matrix }) => {
      delete matrix.accounts;
      matrix.homeserver = "https://matrix.example.test";
      matrix.userId = "@assistant:example.test";
      await expect(createSource().admitInput(input)).resolves.toMatchObject({ version: 1 });
    });
  });

  it("does not allow a caller-selected dispatch key to bypass the native conversation mode", async () => {
    await withSource(async ({ createSource, resolve, admit }) => {
      expect(() => createSource({ dispatchSessionKey: "agent:main:foreign-conversation" })).toThrow(
        "dispatch target changed",
      );
      expect(resolve).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    });
  });

  it("reads fresh pairing grants per input and never pairs a call", async () => {
    await withSource(async ({ matrix, source, readStore, resolve }) => {
      matrix.dm = { policy: "pairing", allowFrom: [] };
      readStore.mockResolvedValueOnce([senderId]).mockResolvedValueOnce([]);
      await expect(source.admitInput(input)).resolves.toMatchObject({ version: 1 });
      await expect(source.admitInput({ ...input, inputId: "input-2" })).rejects.toThrow();
      expect(readStore).toHaveBeenCalledTimes(2);
      expect(resolve.mock.calls.every(([params]) => params.event.mayPair === false)).toBe(true);
    });
  });

  it.each(["disabled", "allowlistOnly"] as const)("retains native DM policy %s", async (change) => {
    await withSource(async ({ matrix, source, readStore }) => {
      matrix.dm = { policy: change === "disabled" ? "disabled" : "pairing", allowFrom: [] };
      matrix.allowlistOnly = change === "allowlistOnly";
      readStore.mockResolvedValue([senderId]);
      await expect(source.admitInput(input)).rejects.toThrow();
      if (change === "allowlistOnly") {
        expect(readStore).not.toHaveBeenCalled();
      }
    });
  });

  it("allows ordinary runtime conversation binding routes", async () => {
    await withSource(async ({ source }) => {
      const original = routes.resolveMatrixInboundRoute;
      vi.spyOn(routes, "resolveMatrixInboundRoute").mockImplementation((params) => ({
        ...original(params),
        runtimeBindingId: "ordinary-bound-conversation",
      }));
      await expect(source.admitInput(input)).resolves.toMatchObject({ version: 1 });
    });
  });

  it.each(["unavailable", "plugin"] as const)("refuses a %s route owner", async (owner) => {
    await withSource(async ({ source, createSource, resolve, admit }) => {
      const original = routes.resolveMatrixInboundRoute;
      vi.spyOn(routes, "resolveMatrixInboundRoute").mockImplementation((params) => ({
        ...original(params),
        ...(owner === "unavailable"
          ? { bindingOwnerAvailable: false }
          : { pluginId: "test-owner" }),
      }));
      expect(() => createSource()).toThrow("unsupported route owner");
      await expect(source.admitInput(input)).rejects.toThrow("unsupported route owner");
      expect(resolve).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    });
  });

  it("refuses a configured ACP dispatch instead of changing its owner", async () => {
    await withSource(async ({ source, createSource, cfg, resolve, admit }) => {
      cfg.bindings = [
        ...(cfg.bindings ?? []),
        {
          type: "acp",
          agentId: "main",
          match: { channel: "matrix", accountId: "default", peer: { kind: "channel", id: roomId } },
        },
      ];
      expect(() => createSource()).toThrow("unsupported route owner");
      await expect(source.admitInput(input)).rejects.toThrow("unsupported route owner");
      expect(resolve).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    });
  });

  it.each(["call", "route", "policy", "admission"] as const)(
    "revalidates %s after native resolution yields",
    async (change) => {
      await withSource(async ({ source, matrix, resolve, nativeResolve, admit, endCall }) => {
        resolve.mockImplementationOnce(async (params) => {
          const result = await nativeResolve(params);
          if (change === "call") {
            endCall();
          } else if (change === "route") {
            matrix.dm = { ...matrix.dm, sessionScope: "per-room" };
          } else if (change === "policy") {
            matrix.dm = { ...matrix.dm, allowFrom: [] };
          } else {
            matrix.rtc = { ...matrix.rtc, enabled: false };
          }
          return result;
        });
        await expect(source.admitInput(input)).rejects.toThrow();
        expect(admit).not.toHaveBeenCalled();
      });
    },
  );

  it("retains the live call check on the issued input rather than just at startup", async () => {
    await withSource(async ({ source, admit, endCall }) => {
      await source.admitInput(input);
      const guard = admit.mock.calls[0]?.[0].assertCurrent;
      expect(guard).toBeTypeOf("function");
      endCall();
      expect(() => guard?.()).toThrow("Original call ended");
    });
  });

  it("captures input identifiers before the asynchronous policy boundary", async () => {
    await withSource(async ({ source, resolve, nativeResolve, admit }) => {
      const request = { ...input };
      resolve.mockImplementationOnce(async (params) => {
        const result = await nativeResolve(params);
        request.inputId = "mutated-after-resolution";
        return result;
      });
      await source.admitInput(request);
      expect(admit.mock.calls[0]?.[0]).toMatchObject({
        input: { inputId: "input-1" },
        scope: { binding: { messageId: "input-1" } },
      });
    });
  });

  it("rejects both call and per-input cancellation before resolving ingress", async () => {
    await withSource(async ({ source, createSource, resolve }) => {
      const controller = new AbortController();
      controller.abort();
      await expect(source.admitInput({ ...input, signal: controller.signal })).rejects.toThrow();
      expect(() => createSource({ signal: controller.signal })).toThrow();
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it("cannot issue admission after the original registered channel is retired", async () => {
    await withSource(async ({ source, retire }) => {
      retire();
      await expect(source.admitInput(input)).rejects.toThrow();
    });
  });
});
