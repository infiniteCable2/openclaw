import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import {
  createMessageUpdateContext,
  endMessage,
} from "../agents/embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  consultRealtimeVoiceAgent,
  type RealtimeVoiceAgentConsultSpeechEvent,
} from "./agent-consult-runtime.js";
import {
  createAgentRuntime,
  useConsultRuntimeTestHooks,
} from "./agent-consult-runtime.test-support.js";

describe("native expressive speech consult", () => {
  useConsultRuntimeTestHooks();
  const base = {
    cfg: {},
    logger: { warn: vi.fn() },
    sessionKey: "agent:example:voice:test",
    messageProvider: "matrix",
    lane: "voice",
    runIdPrefix: "voice:test",
    args: { question: "Answer." },
    transcript: [],
    surface: "a voice call",
    userLabel: "Caller",
  };
  const utterance = (text: string, emotion: string) =>
    setReplyPayloadMetadata(
      { text },
      {
        tts: { tagged: true, text, expression: { emotion, parts: [{ text }] } },
      },
    );

  it("streams native utterances once with different emotions and separate commentary", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const events: RealtimeVoiceAgentConsultSpeechEvent[] = [];
    const expectedSpeechSelection = {
      provider: "example",
      model: "prepared-model",
      voice: "prepared-voice",
    };
    let captured: RunEmbeddedAgentParams | undefined;
    runEmbeddedAgent.mockImplementationOnce(async (params?: RunEmbeddedAgentParams) => {
      captured = params;
      const target = params!.currentSourceReplyTarget!;
      await target.deliver(utterance("Checking.", "neutral"), {
        final: false,
        phase: "commentary",
        toolCallId: "progress",
      });
      await target.deliver(utterance("First sentence.", "joyful"), {
        final: false,
        phase: "final_answer",
        toolCallId: "first",
      });
      await target.deliver(utterance("Second sentence.", "sad"), {
        final: true,
        phase: "final_answer",
        toolCallId: "last",
      });
      await target.deliver(utterance("Second sentence.", "sad"), {
        final: true,
        phase: "final_answer",
        toolCallId: "last",
      });
      return { payloads: [{ text: "Do not repeat this terminal text." }], meta: {} };
    });
    const result = await consultRealtimeVoiceAgent({
      ...base,
      agentRuntime: runtime as never,
      speechExpressionContext: {
        guidance: "Use native structured sends.",
        assertCurrent: vi.fn(),
        expectedSpeechSelection,
      },
      speakCommentary: true,
      onSpeakableText: (event) => {
        events.push(event);
      },
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(captured?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(captured?.onBlockReply).toBeUndefined();
    expect(result.text).toBe("First sentence. Second sentence.");
    expect(events.map((event) => (event.type === "abort" ? "abort" : event.text))).toEqual([
      "Checking.",
      "First sentence.",
      "Second sentence.",
      result.text,
    ]);
    expect(result.utterances?.map((part) => part.speech?.expression?.emotion)).toEqual([
      "neutral",
      "joyful",
      "sad",
    ]);
    for (const event of events) {
      if (event.type === "chunk")
        expect(event.expectedSpeechSelection).toBe(expectedSpeechSelection);
    }
    for (const part of result.utterances ?? []) {
      expect(part.expectedSpeechSelection).toBe(expectedSpeechSelection);
      expect(part.speech).not.toHaveProperty("expectedSpeechSelection");
    }
    expect(() => captured?.currentSourceReplyTarget?.assertCurrent()).toThrow("no longer active");
  });

  it("captures a greeting without speech callbacks and permits execution only through the source message tool", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const sink = vi.fn();
    runEmbeddedAgent.mockImplementationOnce(async (params?: RunEmbeddedAgentParams) => {
      expect(params?.toolExecutionAllow).toEqual(["message"]);
      expect(params?.currentSourceReplyTarget?.sourceOnly).toBe(true);
      await params!.currentSourceReplyTarget!.deliver(utterance("Hello.", "joyful"), {
        final: true,
        phase: "final_answer",
      });
      return { payloads: [], meta: {} };
    });
    const result = await consultRealtimeVoiceAgent({
      ...base,
      agentRuntime: runtime as never,
      speechExpressionContext: { guidance: "Use native structured sends.", assertCurrent: vi.fn() },
      speechExpressionCaptureOnly: true,
      onSpeakableText: sink,
    });
    expect(result.text).toBe("Hello.");
    expect(result.delivered).toBeUndefined();
    expect(sink).not.toHaveBeenCalled();
  });

  it("joins concurrent duplicate native speech calls before their sink handoff settles", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const entered = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    const events: RealtimeVoiceAgentConsultSpeechEvent[] = [];
    runEmbeddedAgent.mockImplementationOnce(async (params?: RunEmbeddedAgentParams) => {
      const target = params!.currentSourceReplyTarget!;
      const payload = utterance("Hello.", "joyful");
      const context = { final: true, phase: "final_answer" as const, toolCallId: "same-call" };
      const first = target.deliver(payload, context);
      await entered.promise;
      const duplicate = target.deliver(payload, context);
      drained.resolve();
      await Promise.all([first, duplicate]);
      return { payloads: [], meta: {} };
    });
    const result = await consultRealtimeVoiceAgent({
      ...base,
      agentRuntime: runtime as never,
      speechExpressionContext: { guidance: "Use native structured sends.", assertCurrent: vi.fn() },
      onSpeakableText: async (event) => {
        events.push(event);
        if (event.type === "chunk") {
          entered.resolve();
          await drained.promise;
        }
      },
    });
    expect(events.filter((event) => event.type === "chunk")).toHaveLength(1);
    expect(result.utterances).toHaveLength(1);
  });

  it("fails enabled expression instead of speaking a plain terminal fallback", async () => {
    const { runtime } = createAgentRuntime([{ text: "Plain fallback." }]);
    const sink = vi.fn();
    await expect(
      consultRealtimeVoiceAgent({
        ...base,
        agentRuntime: runtime as never,
        speechExpressionContext: {
          guidance: "Use native structured sends.",
          assertCurrent: vi.fn(),
        },
        onSpeakableText: sink,
      }),
    ).rejects.toThrow("completed native current-source reply");
    expect(sink.mock.calls.map(([event]) => event.type)).toEqual(["abort"]);
  });

  it("rotates final capture only at the native adopted-input boundary", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const adoptedInput = { role: "user", content: "Only the corrected request is wanted." };
    runEmbeddedAgent.mockImplementationOnce(async (params?: RunEmbeddedAgentParams) => {
      const target = params!.currentSourceReplyTarget!;
      await target.deliver(utterance("Earlier answer.", "neutral"), {
        final: true,
        phase: "final_answer",
        toolCallId: "earlier",
      });
      const context = createMessageUpdateContext({
        state: {
          lastAssistant: {
            role: "assistant",
            content: [{ type: "text", text: "Earlier answer." }],
          },
        },
      });
      context.params.currentSourceReplyTarget = target;
      endMessage(context, { message: adoptedInput });
      expect(context.state.answerSegments).toHaveLength(1);
      await target.deliver(utterance("Corrected answer.", "joyful"), {
        final: true,
        phase: "final_answer",
        toolCallId: "corrected",
      });
      return { payloads: [], meta: {} };
    });
    const result = await consultRealtimeVoiceAgent({
      ...base,
      agentRuntime: runtime as never,
      speechExpressionContext: { guidance: "Use native structured sends.", assertCurrent: vi.fn() },
    });
    expect(result.text).toBe("Corrected answer.");
    expect(result.utterances?.map((part) => part.text)).toEqual(["Corrected answer."]);
    expect(adoptedInput.content).toBe("Only the corrected request is wanted.");
  });

  it.each(
    [true, false].flatMap((streamed) =>
      ["progress", "completed", "duplicate"].map((kind) => ({ streamed, kind })),
    ),
  )(
    "preserves native yielded custody for $kind expressive speech (streamed=$streamed)",
    async ({ streamed, kind }) => {
      const { runtime, runEmbeddedAgent } = createAgentRuntime();
      const acknowledgment = "I started the task and will share its result.";
      const localServiceAdmission = {
        generation: "synthetic-worker",
        signal: new AbortController().signal,
      };
      const expectedSpeechSelection = {
        provider: "example",
        model: "prepared-model",
        voice: "prepared-voice",
      };
      const events: RealtimeVoiceAgentConsultSpeechEvent[] = [];
      let captured: RunEmbeddedAgentParams | undefined;
      const first =
        kind === "duplicate"
          ? acknowledgment
          : kind === "completed"
            ? "Completed result."
            : "Working.";
      runEmbeddedAgent.mockImplementationOnce(async (params?: RunEmbeddedAgentParams) => {
        captured = params;
        vi.spyOn(params!.currentSourceReplyTarget!, "deliver");
        await params!.currentSourceReplyTarget!.deliver(utterance(first, "joyful"), {
          final: kind !== "progress",
          phase: "final_answer",
          toolCallId: "first",
        });
        return {
          payloads: [{ text: "Do not speak this plain terminal fallback." }],
          meta: { yielded: true, yieldAcknowledgment: `  ${acknowledgment}  ` },
        };
      });
      const result = await consultRealtimeVoiceAgent({
        ...base,
        agentRuntime: runtime as never,
        speechExpressionContext: {
          guidance: "Use native structured sends.",
          assertCurrent: vi.fn(),
          localServiceAdmission,
          expectedSpeechSelection,
        },
        ...(streamed
          ? {
              onSpeakableText: (event: RealtimeVoiceAgentConsultSpeechEvent) => {
                events.push(event);
              },
            }
          : {}),
      });
      const capturedTexts = kind === "duplicate" ? [first] : [first, acknowledgment];
      expect(result.yielded).toBe(true);
      expect(result.text).toBe(capturedTexts.join(" "));
      expect(result.utterances?.map((part) => part.text)).toEqual(capturedTexts);
      expect(result.delivered).toBe(streamed ? true : undefined);
      for (const part of result.utterances ?? []) {
        expect(part.localServiceAdmission).toBe(localServiceAdmission);
        expect(part.expectedSpeechSelection).toBe(expectedSpeechSelection);
      }
      if (kind !== "duplicate") {
        expect(result.utterances?.at(-1)?.speech?.expression).toEqual({
          parts: [{ text: acknowledgment }],
        });
        expect(
          vi.mocked(captured!.currentSourceReplyTarget!.deliver).mock.calls.at(-1)?.[1],
        ).toEqual(expect.objectContaining({ final: false, phase: "final_answer" }));
      }
      expect(events.filter((event) => event.type === "chunk").map((event) => event.text)).toEqual(
        streamed ? capturedTexts : [],
      );
      for (const event of events) {
        if (event.type === "chunk") {
          expect(event.localServiceAdmission).toBe(localServiceAdmission);
          expect(event.expectedSpeechSelection).toBe(expectedSpeechSelection);
        }
      }
      expect(events.filter((event) => event.type === "abort")).toHaveLength(0);
      if (streamed) expect(events.at(-1)).toEqual({ type: "done", text: result.text });
    },
  );

  it("does not widen an explicit native tool allowlist for speech presentation", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    await expect(
      consultRealtimeVoiceAgent({
        ...base,
        agentRuntime: runtime as never,
        toolsAllow: ["read"],
        speechExpressionContext: {
          guidance: "Use native structured sends.",
          assertCurrent: vi.fn(),
        },
      }),
    ).rejects.toThrow("permitted by this run's native policy");
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });
});
