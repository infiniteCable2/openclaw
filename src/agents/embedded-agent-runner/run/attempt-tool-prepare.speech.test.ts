import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { getHoisted, resetEmbeddedAttemptHarness } from "./attempt-spawn-workspace.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

// mock-isolation: This source-target authority fixture must not start independent
// automatic channel TTS readiness; that producer has its own real-route tests.
vi.mock("../../../tts/automatic-expression.js", () => ({
  prepareAutomaticSpeechExpressionContext: async () => undefined,
}));

const hoisted = getHoisted();
beforeEach(() => resetEmbeddedAttemptHarness());
afterEach(() => vi.restoreAllMocks());

describe("native speech presentation run ownership", () => {
  it.each([
    { kind: "detached review", detached: true, expectedFailure: false },
    { kind: "denied executor", executionAllow: ["read"], expectedFailure: true },
    { kind: "empty executor", executionAllow: [], expectedFailure: true },
    { kind: "permitted executor", executionAllow: ["message"], expectedFailure: false },
    { kind: "retired audio owner", retired: true, expectedFailure: true },
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
      hoisted.createOpenClawCodingToolsMock.mockReturnValue([
        {
          name: "message",
          label: "message",
          description: "native source delivery",
          parameters: Type.Object({}),
          execute: vi.fn(async () => ({ content: [], details: {} })),
        },
      ]);
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
      }
      expect(source.deliver).not.toHaveBeenCalled();
    } finally {
      await result?.releaseTools("test-complete");
      result?.toolSurfaceRuntime.cleanup();
      admission.close();
    }
  });
});
