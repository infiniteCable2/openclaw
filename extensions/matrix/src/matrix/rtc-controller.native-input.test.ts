import { withRegisteredChannelIngress } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveAgentSpeechConversationRoute } from "openclaw/plugin-sdk/routing";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../channel.js";
import type { CoreConfig } from "../types.js";
import {
  createHarness,
  flushPromises,
  getRtcControllerMocks,
  ownerId,
  roomId,
} from "./rtc-controller.test-helpers.js";

const mocks = getRtcControllerMocks();

describe("MatrixRTC native conversation input caller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["native", "branches"] as const)(
    "wires actual SDK membership to original host admission and %s speech routing",
    async (conversationMode) => {
      await withTempHome(async () => {
        const cfg: CoreConfig = {
          agents: { entries: { example_owner: { conversationMode } } },
          session: { dmScope: "per-channel-peer" },
          channels: {
            matrix: {
              enabled: true,
              accounts: { default: {} },
              dm: { enabled: true, policy: "allowlist", allowFrom: [ownerId] },
              rtc: {
                enabled: true,
                authServiceUrl: "https://rtc.example.test",
                mediaBridgeCommand: "/usr/local/bin/matrix-rtc-bridge",
                transcriptionProvider: "local-stt",
                admissions: [{ roomId, userId: ownerId, agentId: "example_owner" }],
              },
            },
          },
        };
        const plugin: ChannelPlugin = {
          id: "matrix",
          meta: {
            id: "matrix",
            label: "Matrix test",
            selectionLabel: "Matrix test",
            docsPath: "/channels/matrix",
            blurb: "RTC caller proof",
          },
          capabilities: { chatTypes: ["direct"] },
          config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
          bindings: matrixPlugin.bindings,
        };
        await withRegisteredChannelIngress(
          { plugin, config: cfg, setRuntime() {} },
          async (native) => {
            const runtime: PluginRuntime = {
              ...native,
              config: { ...native.config, current: () => cfg },
            };
            const harness = createHarness("matrix_2_0", { cfg, runtime, greeting: true });
            try {
              harness.setRoomKnown(true);
              harness.session.memberships = [harness.remoteMembership];
              harness.managerEmitter.emit("session_started", roomId, harness.session);
              await flushPromises();
              expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
              expect(mocks.createMeetingRealtimeEngineBindingsV2).toHaveBeenCalledOnce();
              const binding = mocks.createMeetingRealtimeEngineBindingsV2.mock.calls[0]![0];
              const engine = mocks.startMeetingAgentRealtimeEngine.mock.calls[0]![0];
              const sourceSessionKey = runtime.channel.routing.resolveAgentRoute({
                cfg,
                channel: "matrix",
                accountId: "default",
                peer: { kind: "direct", id: ownerId },
              }).sessionKey;
              const dispatch = resolveAgentSpeechConversationRoute({
                cfg,
                agentId: "example_owner",
                channel: "matrix",
                accountId: "default",
                sourceSessionKey,
                conversationId: binding.conversationId,
              });
              expect(dispatch.sessionKey === sourceSessionKey).toBe(conversationMode === "native");
              expect(dispatch.sessionKey).not.toContain(":subagent:");
              expect(engine.nativeInput).toBe(
                mocks.createMeetingRealtimeEngineBindingsV2.mock.results[0]!.value.nativeInput,
              );
              expect(binding.connectionPresentation).toMatchObject({
                kind: "call",
                channel: "matrix",
                label: "Matrix audio call",
                readTarget: { agentId: "example_owner", sessionKey: dispatch.sessionKey },
                operations: ["current-turn-reply", "cancel-output"],
              });
              expect(engine.connectionPresentation).toBe(binding.connectionPresentation);
              expect(mocks.prepareMeetingAgentGreeting.mock.calls[0]![0]).toMatchObject({
                requesterSessionKey: sourceSessionKey,
              });
              const normal = await binding.inputSource.admitInput({
                agentId: "example_owner",
                conversationId: binding.conversationId,
                inputId: "original-stt",
                purpose: "user",
              });
              const greeting = await binding.inputSource.admitInput({
                agentId: "example_owner",
                conversationId: binding.conversationId,
                inputId: "original-greeting",
                purpose: "greeting",
              });
              expect(normal).toMatchObject({ version: 1, kind: "conversation-input-admission" });
              expect(greeting).not.toBe(normal);
              harness.session.memberships = [];
              await expect(
                binding.inputSource.admitInput({
                  agentId: "example_owner",
                  conversationId: binding.conversationId,
                  inputId: "after-hangup",
                  purpose: "user",
                }),
              ).rejects.toThrow();
            } finally {
              await harness.controller.stop();
            }
          },
        );
      });
    },
  );
});
