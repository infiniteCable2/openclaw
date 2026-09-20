import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  consultRealtimeVoiceAgent,
  type RealtimeVoiceAgentConsultSpeechEvent,
} from "./agent-consult-runtime.js";
import {
  createAgentRuntime,
  requireEmbeddedAgentCall,
  useConsultRuntimeTestHooks,
} from "./agent-consult-runtime.test-support.js";

describe("realtime voice agent consult speech delivery", () => {
  useConsultRuntimeTestHooks();

  it("interrupts a pending final speech delivery after the agent has returned", async () => {
    const { runtime } = createAgentRuntime();
    const controller = new AbortController();
    const finalDeliveryStarted = createDeferred();
    const deliveryReleased = createDeferred();
    const cleanup = vi.fn();
    const onSpeakableText = vi.fn(async (event: RealtimeVoiceAgentConsultSpeechEvent) => {
      if (event.type === "done") {
        finalDeliveryStarted.resolve();
        await deliveryReleased.promise;
      } else if (event.type === "abort") {
        deliveryReleased.resolve();
      }
    });
    const consult = consultRealtimeVoiceAgent({
      cfg: {},
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey: "voice:late-interruption",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice:late-interruption",
      args: { question: "Answer." },
      transcript: [],
      surface: "a live voice session",
      userLabel: "Caller",
      abortSignal: controller.signal,
      onSpeakableText,
      onRunStarted: () => ({ cleanup }),
    });
    const rejected = expect(consult).rejects.toMatchObject({ name: "AbortError" });
    try {
      await finalDeliveryStarted.promise;
      controller.abort(new Error("Caller interrupted playback"));
      await rejected;
      expect(onSpeakableText.mock.calls.map(([event]) => event)).toEqual([
        { type: "done", text: "Speak this." },
        { type: "abort" },
      ]);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      deliveryReleased.resolve();
      await consult.catch(() => undefined);
    }
  });

  it("discards already queued chunks and completion after a speech sink rejects", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const deliveryStarted = createDeferred();
    const deliveryReleased = createDeferred();
    const failure = new Error("Audio sink closed");
    const onSpeakableText = vi.fn(async (event: RealtimeVoiceAgentConsultSpeechEvent) => {
      if (event.type === "chunk") {
        deliveryStarted.resolve();
        await deliveryReleased.promise;
        throw failure;
      }
    });
    runEmbeddedAgent.mockImplementationOnce(async (runParams?: RunEmbeddedAgentParams) => {
      await runParams?.onBlockReply?.({ text: "First sentence." });
      await deliveryStarted.promise;
      await runParams?.onBlockReply?.({ text: "Queued sentence." });
      deliveryReleased.resolve();
      return { payloads: [{ text: "Complete answer." }], meta: {} };
    });
    await expect(
      consultRealtimeVoiceAgent({
        cfg: {},
        agentRuntime: runtime as never,
        logger: { warn: vi.fn() },
        sessionKey: "voice:delivery-queue-failure",
        messageProvider: "voice",
        lane: "voice",
        runIdPrefix: "voice:delivery-queue-failure",
        args: { question: "Read the report." },
        transcript: [],
        surface: "a live voice session",
        userLabel: "Caller",
        onSpeakableText,
      }),
    ).rejects.toBe(failure);
    expect(onSpeakableText.mock.calls.map(([event]) => event)).toEqual([
      { type: "chunk", text: "First sentence." },
      { type: "abort" },
    ]);
  });

  it.each(["caller", "cancellation", "timeout"] as const)(
    "aborts the speech sink before joining queued delivery after a resolved %s interruption",
    async (interruption) => {
      const { runtime, runEmbeddedAgent } = createAgentRuntime();
      const controller = new AbortController();
      const deliveryStarted = createDeferred();
      const deliveryReleased = createDeferred();
      const cleanup = vi.fn();
      const onSpeakableText = vi.fn(async (event: RealtimeVoiceAgentConsultSpeechEvent) => {
        if (event.type === "abort") {
          deliveryReleased.resolve();
        } else if (event.type === "chunk") {
          deliveryStarted.resolve();
          await deliveryReleased.promise;
        }
      });
      runEmbeddedAgent.mockImplementationOnce(async (runParams?: RunEmbeddedAgentParams) => {
        await runParams?.onBlockReply?.({ text: "First sentence." });
        await deliveryStarted.promise;
        await runParams?.onBlockReply?.({ text: "Queued sentence." });
        if (interruption === "caller") {
          controller.abort(new Error("Caller interrupted"));
        }
        return {
          payloads: [{ text: "Partial answer." }],
          meta:
            interruption === "caller"
              ? {}
              : interruption === "cancellation"
                ? { aborted: true }
                : {
                    aborted: true,
                    stopReason: "timeout",
                    timeoutPhase: "provider",
                    providerStarted: true,
                  },
        };
      });
      try {
        await expect(
          consultRealtimeVoiceAgent({
            cfg: {},
            agentRuntime: runtime as never,
            logger: { warn: vi.fn() },
            sessionKey: "voice:interrupted-stream",
            messageProvider: "voice",
            lane: "voice",
            runIdPrefix: "voice:interrupted-stream",
            args: { question: "Read the report." },
            transcript: [],
            surface: "a live voice session",
            userLabel: "Caller",
            abortSignal: controller.signal,
            onSpeakableText,
            onRunStarted: () => ({ cleanup }),
          }),
        ).rejects.toMatchObject({
          name: interruption === "timeout" ? "TimeoutError" : "AbortError",
        });
        expect(onSpeakableText.mock.calls.map(([event]) => event)).toEqual([
          { type: "chunk", text: "First sentence." },
          { type: "abort" },
        ]);
        expect(cleanup).toHaveBeenCalledOnce();
      } finally {
        deliveryReleased.resolve();
      }
    },
  );

  it("normalizes delivery rejections while retaining their original cause", async () => {
    const { runtime } = createAgentRuntime();
    const failure = { code: "AUDIO_SINK_CLOSED" };
    const onSpeakableText = vi.fn().mockRejectedValue(failure);
    await expect(
      consultRealtimeVoiceAgent({
        cfg: {} as never,
        agentRuntime: runtime as never,
        logger: { warn: vi.fn() },
        sessionKey: "voice:delivery-failure",
        messageProvider: "voice",
        lane: "voice",
        runIdPrefix: "voice:delivery-failure",
        args: { question: "Answer aloud." },
        transcript: [],
        surface: "a live voice session",
        userLabel: "User",
        onSpeakableText,
      }),
    ).rejects.toMatchObject({
      message: "Realtime voice speech delivery failed",
      cause: failure,
    });
    expect(onSpeakableText).toHaveBeenLastCalledWith({ type: "abort" });
  });

  it("streams only native visible answer blocks and marks delivery complete", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime([
      { text: "Erster Satz.\n\nZweiter Satz." },
    ]);
    runEmbeddedAgent.mockImplementationOnce(async (runParams?: RunEmbeddedAgentParams) => {
      await runParams?.onBlockReply?.({ text: "interne Planung", isReasoning: true });
      await runParams?.onBlockReply?.({ text: "Erster Satz." });
      await runParams?.onBlockReply?.({ text: "Zweiter Satz." });
      return {
        payloads: [{ text: "Erster Satz.\n\nZweiter Satz." }],
        meta: {},
      };
    });
    const onSpeakableText = vi.fn(
      async (_event: RealtimeVoiceAgentConsultSpeechEvent) => undefined,
    );

    const result = await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey: "voice:stream",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:stream",
      args: { question: "Antworte." },
      transcript: [],
      surface: "a live voice session",
      userLabel: "User",
      onSpeakableText,
    });

    expect(result).toEqual({ text: "Erster Satz.\n\nZweiter Satz.", delivered: true });
    expect(onSpeakableText.mock.calls.map(([event]) => event)).toEqual([
      { type: "chunk", text: "Erster Satz." },
      { type: "chunk", text: "Zweiter Satz." },
      { type: "done", text: "Erster Satz.\n\nZweiter Satz." },
    ]);
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.enforceFinalTag).toBeUndefined();
    expect(call.blockReplyBreak).toBe("text_end");
    expect(call.blockReplyChunking).toEqual({
      minChars: 48,
      maxChars: 320,
      breakPreference: "sentence",
    });
    expect(call.prompt).not.toContain("<final>...</final>");
  });

  it.each([
    { precedingInput: true, currentFinal: true },
    { precedingInput: true, currentFinal: false },
    { precedingInput: false, currentFinal: false },
  ])(
    "respects input ownership in streamed completion (precedingInput=$precedingInput, currentFinal=$currentFinal)",
    async ({ precedingInput, currentFinal }) => {
      const { runtime, runEmbeddedAgent } = createAgentRuntime();
      const text = "The answer to your current question.";
      runEmbeddedAgent.mockImplementationOnce(async (runParams?: RunEmbeddedAgentParams) => {
        await runParams?.onBlockReply?.({ text });
        return {
          payloads: [
            ...(precedingInput
              ? [
                  setReplyPayloadMetadata(
                    { text: "Earlier answer." },
                    { precedingInputAnswer: true },
                  ),
                ]
              : []),
            ...(currentFinal ? [{ text }] : []),
          ],
          meta: {},
        };
      });
      const onSpeakableText = vi.fn();
      const result = await consultRealtimeVoiceAgent({
        cfg: {},
        agentRuntime: runtime as never,
        logger: { warn: vi.fn() },
        sessionKey: "voice:current-input",
        messageProvider: "voice",
        lane: "voice",
        runIdPrefix: "voice-current-input",
        args: { question: "Answer my current question." },
        transcript: [],
        surface: "a live voice session",
        userLabel: "Caller",
        onSpeakableText,
      });
      const needsFallback = precedingInput && !currentFinal;
      const finalText = needsFallback ? "I need a moment to verify that before answering." : text;
      expect(result).toEqual({ text: finalText, delivered: true });
      expect(onSpeakableText.mock.calls.map(([event]) => event)).toEqual([
        { type: "chunk", text },
        ...(needsFallback ? [{ type: "chunk", text: finalText }] : []),
        { type: "done", text: finalText },
      ]);
    },
  );

  it.each(["none", "complete", "segmented"] as const)(
    "speaks a current final answer after earlier-input speech exactly once (currentStream=%s)",
    async (currentStream) => {
      const { runtime, runEmbeddedAgent } = createAgentRuntime();
      const earlierText = "Earlier answer.";
      const currentChunks = ["Current answer.", "Here are the new details."];
      const currentText = currentChunks.join("\n\n");
      const emittedCurrent =
        currentStream === "none"
          ? []
          : currentStream === "complete"
            ? [currentText]
            : currentChunks;
      runEmbeddedAgent.mockImplementationOnce(async (runParams?: RunEmbeddedAgentParams) => {
        await runParams?.onBlockReply?.({ text: earlierText });
        for (const text of emittedCurrent) {
          await runParams?.onBlockReply?.({ text });
        }
        return {
          payloads: [
            setReplyPayloadMetadata({ text: earlierText }, { precedingInputAnswer: true }),
            { text: currentText },
          ],
          meta: {},
        };
      });
      const onSpeakableText = vi.fn();
      const result = await consultRealtimeVoiceAgent({
        cfg: {},
        agentRuntime: runtime as never,
        logger: { warn: vi.fn() },
        sessionKey: "voice:current-final",
        messageProvider: "voice",
        lane: "voice",
        runIdPrefix: "voice-current-final",
        args: { question: "Answer the new question." },
        transcript: [],
        surface: "a live voice session",
        userLabel: "Caller",
        onSpeakableText,
      });
      expect(result).toEqual({ text: currentText, delivered: true });
      expect(onSpeakableText.mock.calls.map(([event]) => event)).toEqual([
        { type: "chunk", text: earlierText },
        ...(emittedCurrent.length > 0 ? emittedCurrent : [currentText]).map((text) => ({
          type: "chunk",
          text,
        })),
        { type: "done", text: currentText },
      ]);
    },
  );

  it.each([false, true])(
    "delivers a yield acknowledgement after streamed speech without duplication (alreadyQueued=%s)",
    async (alreadyQueued) => {
      const { runtime, runEmbeddedAgent } = createAgentRuntime();
      const acknowledgment = "I will report back when the work is finished.";
      const firstChunk = "I found the relevant documents.";
      runEmbeddedAgent.mockImplementationOnce(async (runParams?: RunEmbeddedAgentParams) => {
        await runParams?.onBlockReply?.({ text: firstChunk });
        if (alreadyQueued) {
          await runParams?.onBlockReply?.({ text: acknowledgment });
        }
        return {
          payloads: [],
          meta: { yielded: true, yieldAcknowledgment: acknowledgment },
        };
      });
      const onSpeakableText = vi.fn(
        async (_event: RealtimeVoiceAgentConsultSpeechEvent) => undefined,
      );
      const result = await consultRealtimeVoiceAgent({
        cfg: {} as never,
        agentRuntime: runtime as never,
        logger: { warn: vi.fn() },
        sessionKey: "voice:stream-yield",
        messageProvider: "voice",
        lane: "voice",
        runIdPrefix: "voice-realtime-consult:stream-yield",
        args: { question: "Find the documents and analyze them." },
        transcript: [],
        surface: "a live voice session",
        userLabel: "User",
        onSpeakableText,
      });
      const spokenText = `${firstChunk}\n\n${acknowledgment}`;
      expect(onSpeakableText.mock.calls.map(([event]) => event)).toEqual([
        { type: "chunk", text: firstChunk },
        { type: "chunk", text: acknowledgment },
        { type: "done", text: spokenText },
      ]);
      expect(result).toEqual({ text: spokenText, delivered: true, yielded: true });
    },
  );

  it.each([false, true])(
    "returns a yielded acknowledgement without waiting for a visible final (streaming=%s)",
    async (streaming) => {
      const warn = vi.fn();
      const onSpeakableText = vi.fn();
      const { runtime, runEmbeddedAgent } = createAgentRuntime();
      runEmbeddedAgent.mockResolvedValueOnce({
        payloads: [],
        meta: {
          yielded: true,
          yieldAcknowledgment: "  Working on it.   I will report back.  ",
        },
      });

      const result = await consultRealtimeVoiceAgent({
        cfg: {} as never,
        agentRuntime: runtime as never,
        logger: { warn },
        sessionKey: "voice:yielded",
        onSpeakableText: streaming ? onSpeakableText : undefined,
        messageProvider: "voice",
        lane: "voice",
        runIdPrefix: "voice:yielded",
        args: { question: "Investigate this" },
        transcript: [],
        surface: "a live voice session",
        userLabel: "Caller",
      });

      expect(result).toEqual({
        text: "Working on it. I will report back.",
        yielded: true,
        ...(streaming ? { delivered: true } : {}),
      });
      if (streaming) {
        expect(onSpeakableText).toHaveBeenCalledExactlyOnceWith({
          type: "done",
          text: "Working on it. I will report back.",
        });
      }
      expect(warn).not.toHaveBeenCalled();
    },
  );
});
