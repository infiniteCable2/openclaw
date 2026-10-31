import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  anthropicEvents,
  createAnthropicResponse,
  registerParityHostLifecycle,
} from "../../../../packages/ai/src/provider-transport-parity.test-support.js";
import { streamSimpleAnthropic } from "../../../../packages/ai/src/providers/anthropic.js";
import type { MessageSpeechAdmission } from "../../../tts/message-speech-admission.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { buildEmbeddedForegroundPromptContext } from "./agent-end-context.js";
import {
  installRuntimeContextMessageForPrompt,
  normalizeMessagesForLlmBoundary,
} from "./attempt-llm-boundary.js";
import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-build.js";

registerParityHostLifecycle();
registerAgentSessionLoopTestLifecycle();

const SYSTEM = "Stable instructions for the same conversation.";
const GUIDANCE = "ADMITTED_SPEECH_GUIDANCE_MARKER: expressive speech is available for this reply.";
const model = {
  ...testModel,
  api: "anthropic-messages" as const,
  provider: "ollama",
  id: "synthetic-text-model",
  baseUrl: "https://ollama.example.test",
};
type PromptInput = Parameters<typeof prepareEmbeddedAttemptPromptContext>[0];

function speechAdmission(assertCurrent = vi.fn()): MessageSpeechAdmission {
  return {
    runId: "audio-turn",
    sessionId: "speech-sequence",
    agentId: "main",
    route: { channel: "matrix", to: "synthetic-private-room" },
    assertCurrent,
    preparedTtsPreferences: { machinePrefsPath: "synthetic-preferences" },
    prefsPath: "synthetic-preferences",
    expectedSpeechSelection: { provider: "synthetic-tts" },
    guidance: GUIDANCE,
  };
}

function captureNativeRequests() {
  const requests: Record<string, unknown>[] = [];
  const fetchRequest = vi.fn<typeof fetch>(async (_input, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a serialized Anthropic provider request");
    }
    const request: unknown = JSON.parse(init.body);
    if (!isRecord(request)) {
      throw new Error("Expected an Anthropic request object");
    }
    requests.push(request);
    return createAnthropicResponse(anthropicEvents);
  });
  configureAiTransportHost({ ...getAiTransportHost(), buildModelFetch: () => fetchRequest });
  // Only HTTP is replaced. The native session loop, provider serialization and
  // SSE reducer remain real; Ollama's Anthropic route has no in-history systems.
  streamMocks.streamSimple.mockImplementation((activeModel, context, options) =>
    streamSimpleAnthropic({ ...activeModel, api: "anthropic-messages" }, context, options),
  );
  return { requests, fetchRequest };
}

async function createConversation() {
  const { session, sessionManager } = await createTestSession({ systemPrompt: SYSTEM, model });
  const convert = session.agent.convertToLlm;
  session.agent.convertToLlm = (messages) =>
    convert(
      normalizeMessagesForLlmBoundary(messages, {
        sessionVersion: 4,
        appendOnlyRuntimeContext: false,
        inHistorySystemUpdates: false,
        includeTimestamp: false,
      }),
    );
  const projection = createToolResultPromptProjectionState();
  return {
    session,
    sessionManager,
    async turn(text: string, attempt: Partial<PromptInput["attempt"]> = {}, isRawModelRun = false) {
      const historyBefore = JSON.stringify(session.messages);
      const prepared = await prepareEmbeddedAttemptPromptContext({
        attempt: { config: {}, sessionId: "speech-sequence", ...attempt },
        capabilityToolNames: new Set(),
        executionHost: false,
        includeBoundaryTimestamp: false,
        isRawModelRun,
        sessionVersion: 4,
        appendOnlyRuntimeContext: false,
        inHistorySystemUpdates: false,
        messages: session.messages,
        prompt: { effectivePrompt: text, effectiveTranscriptPrompt: text },
        replaceSessionMessages: (messages) => {
          session.agent.state.messages = messages;
        },
        sessionAgentId: "main",
        systemPromptText: session.agent.state.systemPrompt,
        toolResultPromptProjectionState: projection,
      });
      expect(JSON.stringify(session.messages)).toBe(historyBefore);
      expect(prepared.systemPromptForHook).toBe(SYSTEM);
      const cleanup = installRuntimeContextMessageForPrompt({
        session,
        message: prepared.runtimeContextMessageForCurrentTurn,
      });
      try {
        await session.prompt(prepared.promptForSession);
      } finally {
        cleanup();
      }
      expect(session.agent.state.systemPrompt).toBe(SYSTEM);
      expect(JSON.stringify(session.messages)).not.toContain(GUIDANCE);
      expect(JSON.stringify(sessionManager.getBranch())).not.toContain(GUIDANCE);
      return prepared;
    },
  };
}

describe("turn-owned speech guidance at the native provider boundary", () => {
  it("preserves system and completed history bytes through text, text, audio, text", async () => {
    const { requests } = captureNativeRequests();
    const prompts = [
      "First text question",
      "Second text question",
      "Audio transcript",
      "Final text",
    ];
    const baseline = await createConversation();
    for (const prompt of prompts) {
      await baseline.turn(prompt);
    }
    const control = requests.splice(0);
    expect(control).toHaveLength(4);

    const conversation = await createConversation();
    const speech = speechAdmission();
    for (const [index, prompt] of prompts.entries()) {
      const prepared = await conversation.turn(
        prompt,
        index === 2 ? { messageSpeechAdmission: speech } : {},
      );
      const actual = requests[index];
      const expected = control[index];
      if (
        !actual ||
        !expected ||
        !Array.isArray(actual.messages) ||
        !Array.isArray(expected.messages)
      ) {
        throw new Error("Expected both native provider payloads");
      }
      expect(JSON.stringify(actual.system)).toBe(JSON.stringify(expected.system));
      // Current carrier projection may add or merge a user message. Completed
      // user/assistant pairs must retain their exact original provider bytes.
      const completedMessages = index * 2;
      expect(JSON.stringify(actual.messages.slice(0, completedMessages))).toBe(
        JSON.stringify(expected.messages.slice(0, completedMessages)),
      );
      expect(
        actual.messages.every((message) => isRecord(message) && message.role !== "system"),
      ).toBe(true);
      if (index === 2) {
        expect(prepared.runtimeContextFragments).toContainEqual({
          kind: "runtime-instruction",
          text: GUIDANCE,
        });
        expect(JSON.stringify(actual.messages.slice(completedMessages))).toContain(GUIDANCE);
      } else {
        expect(JSON.stringify(actual.messages)).toBe(JSON.stringify(expected.messages));
        expect(prepared.runtimeContextFragments).not.toContainEqual({
          kind: "runtime-instruction",
          text: GUIDANCE,
        });
      }
    }
    expect(requests).toHaveLength(4);
    expect(speech.assertCurrent).toHaveBeenCalled();
  });

  it("refuses admission retired across prompt preparation before any provider request", async () => {
    const { fetchRequest } = captureNativeRequests();
    const conversation = await createConversation();
    let current = true;
    const speech = speechAdmission(
      vi.fn(() => {
        if (!current) {
          throw new Error("Speech admission retired");
        }
      }),
    );
    const pending = conversation.turn("Audio transcript", { messageSpeechAdmission: speech });
    current = false;
    await expect(pending).rejects.toThrow("Speech admission retired");
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(conversation.session.messages).toHaveLength(0);
  });

  it.each(["raw", "detached"] as const)(
    "does not give a %s request inherited speech capabilities",
    async (kind) => {
      const { requests } = captureNativeRequests();
      const conversation = await createConversation();
      const speech = speechAdmission();
      const source = {
        agentId: "main",
        sessionId: "speech-sequence",
        workspaceDir: "/synthetic-workspace",
        messageSpeechAdmission: speech,
      };
      const detached = buildEmbeddedForegroundPromptContext(source, "/synthetic-agent");
      expect(detached).not.toHaveProperty("messageSpeechAdmission");
      const prepared = await conversation.turn(
        "Current request",
        kind === "raw" ? { messageSpeechAdmission: speech } : detached,
        kind === "raw",
      );
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).not.toContain(GUIDANCE);
      expect(prepared.runtimeContextFragments).not.toContainEqual({
        kind: "runtime-instruction",
        text: GUIDANCE,
      });
    },
  );
});
