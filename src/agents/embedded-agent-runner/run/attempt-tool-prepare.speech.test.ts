import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createStageTimingTracker } from "../../../shared/stage-timing.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { getHoisted, resetEmbeddedAttemptHarness } from "./attempt-spawn-workspace.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

const timing = vi.hoisted(() => ({
  prepareSpeech:
    vi.fn<
      typeof import("../../../tts/automatic-expression.js").prepareAutomaticSpeechExpressionContext
    >(),
  loadInventory:
    vi.fn<
      typeof import("../../computer-use-node-capabilities.js").loadPairedComputerUseAvailabilityForSurface
    >(),
}));

// mock-isolation: Exercise readiness ownership and timing without starting speech/node services.
vi.mock("../../../tts/automatic-expression.js", () => ({
  prepareAutomaticSpeechExpressionContext: timing.prepareSpeech,
}));
// mock-isolation: Keep paired-node inventory RPC and its process cache outside this timing fixture.
vi.mock("../../computer-use-node-capabilities.js", () => ({
  loadPairedComputerUseAvailabilityForSurface: timing.loadInventory,
}));

const hoisted = getHoisted();
beforeEach(() => {
  resetEmbeddedAttemptHarness();
  timing.prepareSpeech.mockReset().mockResolvedValue(undefined);
  timing.loadInventory.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("native speech presentation run ownership", () => {
  it("separates readiness, inventory and construction from policy without preparing speech twice", async () => {
    let clock = 0;
    const tracker = createStageTimingTracker(() => clock);
    const config: OpenClawConfig = {
      tools: { codeMode: false, toolSearch: { enabled: false } },
      talk: {
        speech: {
          agentProfiles: {
            example: { expression: { channels: { matrix: { targets: ["voice-note"] } } } },
          },
        },
      },
    };
    const admission = prepareSystemAgentRunAdmission(config, "speech-timing", "example", "test");
    const release = vi.fn(async () => {});
    let result: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>> | undefined;
    try {
      timing.prepareSpeech.mockImplementation(async (params) => {
        params.assertCurrent();
        clock += 19_000;
        return {
          guidance: "Prepared speech guidance.",
          messageSpeechAdmission: {
            runId: params.runId,
            sessionId: params.sessionId,
            agentId: "example",
            route: { channel: "matrix", to: "example-room" },
            assertCurrent: () => params.assertCurrent(),
            preparedTtsPreferences: {},
            prefsPath: "",
            expectedSpeechSelection: { provider: "example" },
          },
          release,
        };
      });
      timing.loadInventory.mockImplementation(async () => {
        clock += 700;
        return undefined;
      });
      hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => {
        clock += 500;
        options?.recordToolPrepStage?.("tool-construction-provenance");
        clock += 200;
        options?.recordToolPrepStage?.("tool-policy");
        clock += 100;
        return [];
      });
      // The native run admission remains real; service and tool collaborators only advance
      // a deterministic clock. No model, readiness request or node RPC is performed.
      const attempt = {
        config,
        runId: "speech-timing",
        sessionId: "speech-timing",
        sessionKey: "agent:example:speech-timing",
        agentDir: "/tmp/speech-timing-agent",
        messageChannel: "matrix",
        modelId: "test-model",
        provider: "example-provider",
        model: makeProviderModelFixture({
          id: "test-model",
          provider: "example-provider",
          api: "openai-completions",
          baseUrl: "https://provider.example/v1",
        }),
        authProfileStore: { version: 1, profiles: {} },
        admittedRunContext: await admission.admit("embedded"),
        currentInboundAudio: true,
        preparedTtsPreferences: {},
      } as EmbeddedRunAttemptInternalParams;
      result = await prepareEmbeddedAttemptToolBase({
        attempt,
        agentDir: attempt.agentDir!,
        setup: createAttemptSetupFixture({
          sandboxSessionKey: attempt.sessionKey!,
          sessionAgentId: "example",
        }),
        markCoreToolStage: tracker.mark,
        onYield: async () => {},
        runAbortController: new AbortController(),
        runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
        skillUsagePaths: [],
        skillsSnapshot: undefined,
        codeModeSkills: [],
        toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
      });
      const durations = Object.fromEntries(
        tracker.snapshot().stages.map((stage) => [stage.name, stage.durationMs]),
      );
      expect(durations).toMatchObject({
        "automatic-speech-readiness": 19_000,
        "computer-inventory": 700,
        "tool-construction-provenance": 500,
        "tool-policy": 200,
        "attempt:create-openclaw-coding-tools": 100,
      });
      expect(release).not.toHaveBeenCalled();
      await result.refreshPermissionMode(null, () => {});
      expect(timing.prepareSpeech).toHaveBeenCalledOnce();
      expect(timing.loadInventory).toHaveBeenCalledOnce();
      expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledTimes(2);
      await result.releaseTools("test-complete");
      expect(release).toHaveBeenCalledOnce();
      result.toolSurfaceRuntime.cleanup();
      result = undefined;
    } finally {
      await result?.releaseTools("test-complete");
      result?.toolSurfaceRuntime.cleanup();
      admission.close();
    }
  });

  it.each([
    { kind: "detached review", detached: true, expectedFailure: false },
    { kind: "denied executor", executionAllow: ["read"], expectedFailure: true },
    { kind: "empty executor", executionAllow: [], expectedFailure: true },
    { kind: "permitted executor", executionAllow: ["message"], expectedFailure: false },
    { kind: "retired audio owner", retired: true, expectedFailure: true },
    {
      kind: "native speech without message",
      native: true,
      executionAllow: [],
      expectedFailure: false,
    },
  ])("respects $kind before model execution", async (scenario) => {
    const config: OpenClawConfig = {
      tools: { codeMode: false, toolSearch: { enabled: false } },
      talk: {
        speech: {
          agentProfiles: {
            example: { expression: { channels: { matrix: { targets: ["voice-note"] } } } },
          },
        },
      },
    };
    const admission = prepareSystemAgentRunAdmission(config, "speech-prep", "example", "test");
    let result: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>> | undefined;
    const source = {
      runId: "speech-prep",
      sessionId: "speech-prep",
      assertCurrent: vi.fn(),
      speechUtteranceOnly: true as const,
      deliver: vi.fn(async () => {}),
    };
    try {
      hoisted.createOpenClawCodingToolsMock.mockReturnValue(
        scenario.native
          ? []
          : [
              {
                name: "message",
                label: "message",
                description: "native source delivery",
                parameters: Type.Object({}),
                execute: vi.fn(async () => ({ content: [], details: {} })),
              },
            ],
      );
      // This fixture runs only native preparation; unrelated execution collaborators
      // belong to the shared embedded harness and no model or provider is invoked.
      const attempt = {
        config,
        runId: "speech-prep",
        sessionId: "speech-prep",
        sessionKey: "agent:example:speech-prep",
        agentDir: "/tmp/speech-prep-agent",
        messageChannel: "matrix",
        modelId: "test-model",
        provider: "example-provider",
        model: makeProviderModelFixture({
          id: "test-model",
          provider: "example-provider",
          api: "openai-completions",
          baseUrl: "https://provider.example/v1",
        }),
        authProfileStore: { version: 1, profiles: {} },
        admittedRunContext: await admission.admit("embedded"),
        extraSystemPrompt: "Original foreground context.",
        currentInboundAudio: scenario.detached === true || scenario.retired === true,
        sessionPersistence: scenario.detached ? "detached" : "durable",
        toolExecutionAllow: scenario.executionAllow,
        currentSourceReplyTarget: scenario.detached ? undefined : source,
        sourceReplyDeliveryMode:
          scenario.detached || scenario.native ? undefined : "message_tool_only",
        ...(scenario.native
          ? { nativeSpeechPresentation: { assertCurrent: source.assertCurrent } }
          : {}),
      } as EmbeddedRunAttemptInternalParams;
      if (scenario.retired) {
        admission.close();
      }
      const prepare = () =>
        prepareEmbeddedAttemptToolBase({
          attempt,
          agentDir: attempt.agentDir!,
          setup: createAttemptSetupFixture({
            sandboxSessionKey: attempt.sessionKey!,
            sessionAgentId: "example",
          }),
          markCoreToolStage: () => {},
          onYield: async () => {},
          runAbortController: new AbortController(),
          runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
          skillUsagePaths: [],
          skillsSnapshot: undefined,
          codeModeSkills: [],
          toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
        });
      if (scenario.expectedFailure) {
        await expect(prepare()).rejects.toThrow(
          scenario.retired ? "admitted native run authority" : "resolved tool policy",
        );
      } else {
        result = await prepare();
        expect(attempt.messageSpeechAdmission).toBeUndefined();
        expect(attempt.extraSystemPrompt).toBe("Original foreground context.");
        if (scenario.native) {
          expect(result.forceDirectMessageTool).toBe(false);
          expect(result.toolsRaw.some((tool) => tool.name === "message")).toBe(false);
          expect(attempt.toolExecutionAllow).toEqual([]);
        }
      }
      expect(source.deliver).not.toHaveBeenCalled();
    } finally {
      await result?.releaseTools("test-complete");
      result?.toolSurfaceRuntime.cleanup();
      admission.close();
    }
  });
});
