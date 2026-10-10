import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import type { RealtimeVoiceAgentControlResult } from "../agent-run-control.js";
import { startSpeechSession } from "./session.js";
import type { SpeechAgentConsultParams } from "./types.js";

async function createFixture(streaming: "off" | "sentence" = "sentence", echoDetection = false) {
  vi.useFakeTimers();
  let callbacks!: Parameters<RealtimeTranscriptionProviderPlugin["createSession"]>[0];
  const provider: RealtimeTranscriptionProviderPlugin = {
    id: "test-stt",
    label: "Test STT",
    transcriptGranularity: "utterance",
    isConfigured: () => true,
    createSession: (params) => {
      callbacks = params;
      return { connect: async () => {}, close() {}, sendAudio() {}, isConnected: () => true };
    },
  };
  const done = createDeferred<{ text: string; delivered?: boolean }>();
  const admitted = createDeferred<RealtimeVoiceAgentControlResult>();
  const control = vi.fn(
    (_text: string, _onQueueAccepted?: (accepted: boolean) => void) => admitted.promise,
  );
  let consult!: SpeechAgentConsultParams;
  const consultAgent = vi.fn(async (params: SpeechAgentConsultParams) => {
    consult = params;
    params.onRunControl?.(control);
    try {
      return await done.promise;
    } finally {
      params.onRunControl?.(undefined);
    }
  });
  const tts = vi.fn(async (_params: { text: string }) => ({
    success: true,
    sampleRate: 24_000,
    outputFormat: "pcm",
    audioStream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 0, 2, 0]));
        controller.close();
      },
    }),
  }));
  const writeOutput = vi.fn(async () => {});
  const handle = await startSpeechSession({
    config: {
      audioFormat: "pcm16-24khz",

      transcriptionProvider: provider.id,
      responseStreaming: streaming,
      providers: { [provider.id]: {} },
    },
    fullConfig: {},
    runtime: { tts: { streamTextToSpeechTelephony: tts } } as unknown as PluginRuntime,
    surface: { displayName: "Test", logScope: "test", sessionIdPrefix: "test" },
    sessionId: "steering",
    transport: {
      onFatal() {},
      startInput() {},
      writeOutput,
      inputAudioIsolated: !echoDetection,
      supportsFullDuplexInput: true,
      clearOutput: async () => {},
      stop: async () => {},
      dispose: async () => {},
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    providers: [provider],
    consultAgent,
  });
  return {
    callbacks,
    handle,
    done,
    admitted,
    control,
    consultAgent,
    tts,
    writeOutput,
    get consult() {
      return consult;
    },
    say: (text: string, utteranceId?: string) => {
      if (!callbacks.onTranscript) {
        throw new Error("Missing transcript handler");
      }
      callbacks.onTranscript(text, utteranceId ? { utteranceId } : undefined);
    },
    drain: () => vi.advanceTimersByTimeAsync(0),
  };
}

const accepted: RealtimeVoiceAgentControlResult = {
  ok: true,
  mode: "followup",
  sessionKey: "test",
  active: true,
  queued: true,
  message: "Adopted",
  speak: true,
  show: true,
  suppress: false,
};

describe("meeting native input steering", () => {
  afterEach(() => vi.useRealTimers());

  it("returns idle without inventing output and rejects steering without an active native owner", async () => {
    const f = await createFixture();
    try {
      expect(f.handle.cancelOutput()).toEqual({ status: "idle", turnId: undefined });
      await expect(f.handle.steer({ text: "Do this." })).rejects.toThrow(
        "No active native speech consult",
      );
      expect(f.consultAgent).not.toHaveBeenCalled();
      expect(f.control).not.toHaveBeenCalled();
    } finally {
      await f.handle.stop();
    }
  });

  it("cancels queued delivery before synthesis without aborting or replaying the agent task", async () => {
    const f = await createFixture();
    try {
      f.say("Check the light.");
      await f.drain();
      await f.consult.onSpeakableText?.({ type: "chunk", text: "I am checking." });
      const turnId = f.handle
        .getHealth()
        .recentTalkEvents.findLast((event) => event.type === "turn.started")?.turnId;
      expect(f.handle.cancelOutput({ turnId: "different" }).status).toBe("stale");
      expect(f.handle.cancelOutput({ turnId }).status).toBe("applied");
      f.done.resolve({ text: "The light is on.", delivered: true });
      await f.drain();
      expect(f.writeOutput).not.toHaveBeenCalled();
      expect(f.consult.abortSignal?.aborted).toBe(false);
      expect(f.consultAgent).toHaveBeenCalledOnce();
      expect(f.consult.transcript).toContainEqual(
        expect.objectContaining({
          text: "The light is on.",
          audioDelivery: "unplayed",
        }),
      );
    } finally {
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it("uses the exact native control callback for explicit steering and awaits its settlement", async () => {
    const f = await createFixture("off");
    try {
      f.say("Check the light.");
      await f.drain();
      const assertCurrent = vi.fn();
      const signal = new AbortController().signal;
      const steering = f.handle.steer({
        text: "Also check the printer.",
        mode: "followup",
        signal,
        assertCurrent,
      });
      await f.drain();
      expect(f.control).toHaveBeenCalledWith(
        "Also check the printer.",
        undefined,
        expect.objectContaining({ mode: "followup", signal, assertCurrent }),
      );
      f.done.resolve({ text: "Both are ready." });
      await f.drain();
      expect(f.tts).not.toHaveBeenCalled();
      f.admitted.resolve(accepted);
      await expect(steering).resolves.toEqual(accepted);
      await f.drain();
      expect(f.consultAgent).toHaveBeenCalledOnce();
      expect(f.consult.abortSignal?.aborted).toBe(false);
      expect(f.tts).toHaveBeenCalledWith(expect.objectContaining({ text: "Both are ready." }));
    } finally {
      f.admitted.resolve(accepted);
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it.each(["off", "sentence"] as const)(
    "binds speech onset to A when A finishes before B's transcript with %s output",
    async (streaming) => {
      const f = await createFixture(streaming);
      try {
        f.say("Check the light.");
        await f.drain();
        const startedAt = new Date().toISOString();
        f.callbacks.onSpeechActivity?.({ utteranceId: "b", state: "candidate" });
        await f.consult.onSpeakableText?.({ type: "chunk", text: "The light is on." });
        await f.consult.onSpeakableText?.({ type: "done", text: "The light is on." });
        f.done.resolve({ text: "The light is on.", delivered: streaming === "sentence" });
        await f.drain();
        expect(f.writeOutput).not.toHaveBeenCalled();
        expect(f.consult.abortSignal?.aborted).toBe(false);
        let next: SpeechAgentConsultParams | undefined;
        f.consultAgent.mockImplementationOnce(async (params) => {
          next = params;
          return { text: "The light is on. The printer is ready." };
        });
        await vi.advanceTimersByTimeAsync(2_000);
        f.say("Also check the printer.", "b");
        await f.drain();
        expect(f.control).not.toHaveBeenCalled(); // Native A already closed.
        expect(f.consultAgent).toHaveBeenCalledTimes(2);
        expect(next?.args).toMatchObject({ question: "Also check the printer." });
        expect(next?.transcript).toContainEqual(
          expect.objectContaining({
            role: "user",
            text: "Also check the printer.",
            speechStart: { at: startedAt, precedingRequest: "Check the light." },
          }),
        );
        expect(next?.transcript).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            text: "The light is on.",
            audioDelivery: "unplayed",
          }),
        );
        expect(
          next?.transcript.filter(
            (entry) => entry.role === "assistant" && entry.text === "The light is on.",
          ),
        ).toHaveLength(1);
        expect(f.writeOutput).toHaveBeenCalledOnce();
      } finally {
        f.done.resolve({ text: "" });
        await f.handle.stop();
      }
    },
  );

  it.each(["unplayed", "interrupted", "submitted"] as const)(
    "preserves %s stream evidence without duplicating the final unplayed answer",
    async (delivery) => {
      // Track estimated playout to distinguish submitted from still audible
      // tiny PCM output; isolated fixtures intentionally omit that tracker.
      const f = await createFixture("sentence", true);
      try {
        f.say("Check the light.");
        await f.drain();
        if (delivery === "unplayed") {
          f.callbacks.onSpeechActivity?.({ utteranceId: "b", state: "candidate" });
        }
        await f.consult.onSpeakableText?.({ type: "chunk", text: "The light is on." });
        await f.drain();
        if (delivery === "submitted") {
          await vi.advanceTimersByTimeAsync(20);
        }
        if (delivery !== "unplayed") {
          f.callbacks.onSpeechActivity?.({ utteranceId: "b", state: "candidate" });
        }
        await f.consult.onSpeakableText?.({ type: "chunk", text: "Its level is fifty percent." });
        f.done.resolve({
          text: "The light is on.\nIts level is fifty percent. The timer is inactive.",
          delivered: true,
        });
        await f.drain();
        f.consultAgent.mockResolvedValueOnce({ text: "" });
        f.say("Also check the printer.", "b");
        await f.drain();
        expect(f.consult.transcript.filter((entry) => entry.role === "assistant")).toEqual([
          expect.objectContaining({ text: "The light is on.", audioDelivery: delivery }),
          expect.objectContaining({
            text: "Its level is fifty percent.",
            audioDelivery: "unplayed",
          }),
          expect.objectContaining({ text: "The timer is inactive.", audioDelivery: "unplayed" }),
        ]);
        expect(f.control).not.toHaveBeenCalled();
        expect(f.writeOutput).toHaveBeenCalledTimes(delivery === "unplayed" ? 0 : 1);
      } finally {
        f.done.resolve({ text: "" });
        await f.handle.stop();
      }
    },
  );

  it("keeps distinct commentary and prior turns when an adoption is unconfirmed", async () => {
    const f = await createFixture();
    try {
      f.handle.speak("The light is on.");
      await f.drain();
      await vi.advanceTimersByTimeAsync(20);
      f.say("Check the light again.");
      await f.drain();
      f.callbacks.onSpeechActivity?.({ utteranceId: "b", state: "candidate" });
      await f.consult.onSpeakableText?.({ type: "chunk", text: "Checking its current state." });
      await f.consult.onSpeakableText?.({ type: "chunk", text: "The light is on." });
      f.say("Also check the printer.", "b");
      f.admitted.resolve({ ...accepted, ok: false, reason: "delivery_unconfirmed" });
      f.done.resolve({ text: "The light is on.", delivered: true });
      await f.drain();
      const entries = f.consult.transcript.filter((entry) => entry.role === "assistant");
      expect(entries.slice(0, 3)).toEqual([
        expect.objectContaining({ text: "The light is on.", audioDelivery: "submitted" }),
        expect.objectContaining({ text: "Checking its current state.", audioDelivery: "unplayed" }),
        expect.objectContaining({ text: "The light is on.", audioDelivery: "unplayed" }),
      ]);
      expect(entries).toHaveLength(4);
      expect(entries[3]?.text).toContain("couldn't confirm");
      expect(f.consultAgent).toHaveBeenCalledOnce();
    } finally {
      f.admitted.resolve(accepted);
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it.each(["rejected", "empty", "failed", "cancelled", "empty-transcript"] as const)(
    "releases an onset without steering or losing the pending answer on %s",
    async (outcome) => {
      const f = await createFixture("off");
      try {
        f.say("Check the light.");
        await f.drain();
        f.callbacks.onSpeechActivity?.({ utteranceId: "noise", state: "candidate" });
        f.done.resolve({ text: "The light is on." });
        await f.drain();
        expect(f.tts).not.toHaveBeenCalled();
        if (outcome === "rejected") {
          f.callbacks.onSpeechActivity?.({ utteranceId: "noise", state: "rejected" });
        } else if (outcome === "empty-transcript") {
          // An empty decoder result has no actionable content even without a terminal callback.
          f.say(" ", "noise");
        } else {
          f.callbacks.onProcessing?.({ utteranceId: "noise", state: outcome });
        }
        await f.drain();
        expect(f.control).not.toHaveBeenCalled();
        expect(f.consultAgent).toHaveBeenCalledOnce();
        expect(f.tts).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "The light is on." }),
        );
      } finally {
        f.done.resolve({ text: "" });
        await f.handle.stop();
      }
    },
  );

  it("releases a real assistant echo without adopting it as a caller addition", async () => {
    const f = await createFixture("off", true);
    try {
      const echoed = "I can help with your next question.";
      f.handle.speak(echoed);
      await f.drain();
      f.say("Check the light.");
      await f.drain();
      f.callbacks.onSpeechActivity?.({ utteranceId: "echo", state: "candidate" });
      f.done.resolve({ text: "The light is on." });
      await f.drain();
      f.say(echoed, "echo");
      await f.drain();
      expect(f.consultAgent).toHaveBeenCalledOnce();
      expect(f.control).not.toHaveBeenCalled();
      expect(f.tts.mock.calls.map(([params]) => params.text)).toEqual([echoed, "The light is on."]);
      expect(f.consult.transcript.at(-2)).not.toHaveProperty("speechStart");
    } finally {
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it("keeps onset-time playback evidence after the estimated audio window expires", async () => {
    const f = await createFixture("off", true);
    try {
      f.say("Check the light.");
      await f.drain();
      f.done.resolve({ text: "The light is on." });
      await f.drain();
      const answer = f.consult.transcript.find((entry) => entry.text === "The light is on.");
      expect(answer).toHaveProperty("audioDelivery", "submitted");
      f.callbacks.onSpeechActivity?.({ utteranceId: "b", state: "candidate" });
      const startedAt = new Date().toISOString();
      await vi.advanceTimersByTimeAsync(10_000);
      let next: SpeechAgentConsultParams | undefined;
      f.consultAgent.mockImplementationOnce(async (params) => {
        next = params;
        return { text: "Both results." };
      });
      f.say("Also check the printer.", "b");
      await f.drain();
      expect(answer).toHaveProperty("audioDelivery", "interrupted");
      expect(next?.transcript).toContainEqual(
        expect.objectContaining({
          text: "Also check the printer.",
          speechStart: { at: startedAt, precedingRequest: "Check the light." },
        }),
      );
      expect(f.control).not.toHaveBeenCalled();
      expect(f.consultAgent).toHaveBeenCalledTimes(2);
    } finally {
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it("keeps overlapping B and C behind completed A in native queue order", async () => {
    const f = await createFixture("off");
    try {
      f.say("A");
      await f.drain();
      f.callbacks.onSpeechActivity?.({ utteranceId: "b", state: "candidate" });
      f.done.resolve({ text: "Result A" });
      await f.drain();
      f.callbacks.onSpeechActivity?.({ utteranceId: "c", state: "candidate" });
      f.say("B", "b");
      await f.drain();
      expect(f.consultAgent).toHaveBeenCalledOnce();
      expect(f.tts).not.toHaveBeenCalled();
      let next: SpeechAgentConsultParams | undefined;
      f.consultAgent.mockImplementationOnce(async (params) => {
        next = params;
        return { text: "Results A, B and C" };
      });
      f.say("C", "c");
      await f.drain();
      expect(next?.args).toMatchObject({ question: "B\nC" });
      expect(f.control).not.toHaveBeenCalled();
      expect(f.tts).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Results A, B and C" }),
      );
    } finally {
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it("steers the exact still-live onset owner without aborting or replaying it", async () => {
    const f = await createFixture();
    try {
      f.say("Check the light.");
      await f.drain();
      f.callbacks.onSpeechActivity?.({ utteranceId: "b", state: "candidate" });
      f.say("Also check the printer.", "b");
      await f.drain();
      expect(f.control).toHaveBeenCalledExactlyOnceWith(
        "Also check the printer.",
        expect.any(Function),
      );
      expect(f.consult.abortSignal?.aborted).toBe(false);
      f.admitted.resolve(accepted);
      f.done.resolve({ text: "Both are ready." });
      await f.drain();
      expect(f.consultAgent).toHaveBeenCalledOnce();
      expect(f.tts).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Both are ready." }),
      );
    } finally {
      f.admitted.resolve(accepted);
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it("settles all pending onset holds when the call closes", async () => {
    const f = await createFixture();
    f.say("Check the light.");
    await f.drain();
    f.callbacks.onSpeechActivity?.({ utteranceId: "b", state: "candidate" });
    await f.consult.onSpeakableText?.({ type: "chunk", text: "The light is on." });
    f.done.resolve({ text: "The light is on.", delivered: true });
    await f.drain();
    await f.handle.stop();
    f.say("Too late.", "b");
    await f.drain();
    expect(f.consultAgent).toHaveBeenCalledOnce();
    expect(f.writeOutput).not.toHaveBeenCalled();
  });

  it("holds a later sentence starting in a playback gap until the candidate settles", async () => {
    const f = await createFixture();
    try {
      f.say("Check the light.");
      await f.drain();
      await f.consult.onSpeakableText?.({ type: "chunk", text: "First sentence." });
      await f.drain();
      expect(f.writeOutput).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_000);
      f.callbacks.onSpeechActivity?.({ utteranceId: "noise", state: "candidate" });
      await f.consult.onSpeakableText?.({ type: "chunk", text: "Second sentence." });
      await f.drain();
      expect(f.writeOutput).toHaveBeenCalledOnce();
      f.callbacks.onSpeechActivity?.({ utteranceId: "noise", state: "rejected" });
      await f.drain();
      expect(f.writeOutput).toHaveBeenCalledTimes(2);
      expect(f.control).not.toHaveBeenCalled();
    } finally {
      f.done.resolve({ text: "", delivered: true });
      await f.handle.stop();
    }
  });

  it.each(["off", "sentence"] as const)(
    "retains A and B through one native run with %s output, including a late admission acknowledgment",
    async (streaming) => {
      const f = await createFixture(streaming);
      try {
        f.say("Check the light.");
        await f.drain();
        expect(f.consultAgent).toHaveBeenCalledOnce();
        expect(f.consult.waitForPendingInput?.()).toBeUndefined();
        f.say("Also check the printer.");
        await f.drain();
        expect(f.control).toHaveBeenCalledExactlyOnceWith("Also check the printer.");
        expect(f.consult.abortSignal?.aborted).toBe(false);
        await f.consult.onSpeakableText?.({ type: "chunk", text: "Old buffered speech." });
        const text = "The light is on. The printer is ready.";
        await f.consult.onSpeakableText?.({ type: "done", text });
        f.done.resolve({ text, delivered: streaming === "sentence" });
        await f.drain();
        expect(f.tts).not.toHaveBeenCalled();
        f.admitted.resolve(accepted);
        await f.drain();
        expect(f.consultAgent).toHaveBeenCalledOnce();
        expect(f.tts).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text }));
        expect(f.writeOutput).toHaveBeenCalledOnce();
      } finally {
        f.done.resolve({ text: "" });
        f.admitted.resolve(accepted);
        await f.handle.stop();
      }
    },
  );

  it("queues rejected inputs in order and carries completed but unspoken results into the next consult", async () => {
    const f = await createFixture();
    f.control.mockImplementationOnce(() => f.admitted.promise).mockResolvedValue(accepted);
    try {
      f.say("Check the light.");
      await f.drain();
      f.say("Check the printer.");
      f.say("Also check the paper.");
      f.admitted.resolve({ ...accepted, ok: false, queued: false, reason: "no_active_run" });
      await f.drain();
      expect(f.control).toHaveBeenCalledExactlyOnceWith("Check the printer.");
      let next: SpeechAgentConsultParams | undefined;
      f.consultAgent.mockImplementationOnce(async (params) => {
        next = params;
        return { text: "All checked." };
      });
      f.done.resolve({ text: "The light is on." });
      await f.drain();
      expect(f.consultAgent).toHaveBeenCalledTimes(2);
      expect(next?.args).toMatchObject({ question: "Check the printer.\nAlso check the paper." });
      expect(next?.transcript).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          text: "The light is on.",
          audioDelivery: "unplayed",
        }),
      );
      expect(f.tts.mock.calls.map(([params]) => params.text)).toEqual(["All checked."]);
    } finally {
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it.each(["unconfirmed", "exception"] as const)("does not replay an %s adoption", async (mode) => {
    const f = await createFixture();
    try {
      f.say("Check the light.");
      await f.drain();
      f.say("Switch it off.");
      if (mode === "exception") {
        f.admitted.reject(new Error("Transport lost after admission"));
      } else {
        f.admitted.resolve({ ...accepted, ok: false, reason: "delivery_unconfirmed" });
      }
      f.done.resolve({ text: "Done." });
      await f.drain();
      expect(f.consultAgent).toHaveBeenCalledOnce();
      expect(f.control).toHaveBeenCalledOnce();
      expect(f.tts).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          text: expect.stringContaining("couldn't confirm"),
        }),
      );
    } finally {
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it("never requeues or speaks after closing while steering is pending", async () => {
    const f = await createFixture();
    f.say("Check the light.");
    await f.drain();
    f.say("Also check the printer.");
    await f.drain();
    await f.handle.stop();
    f.admitted.resolve({ ...accepted, ok: false, queued: false, reason: "no_active_run" });
    f.done.resolve({ text: "The light is on." });
    await f.drain();
    expect(f.consultAgent).toHaveBeenCalledOnce();
    expect(f.tts).not.toHaveBeenCalled();
  });

  it("keeps ordinary sentence streaming and does not steer empty input", async () => {
    const f = await createFixture();
    try {
      f.say("Check the light.");
      await f.drain();
      f.say(" ");
      await f.consult.onSpeakableText?.({ type: "chunk", text: "Checking the light." });
      await f.drain();
      expect(f.tts).toHaveBeenCalledOnce();
      expect(f.control).not.toHaveBeenCalled();
      await f.consult.onSpeakableText?.({ type: "done", text: "Checking the light." });
      f.done.resolve({ text: "Checking the light.", delivered: true });
      await f.drain();
      expect(f.tts).toHaveBeenCalledOnce();
    } finally {
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it("releases native completion on admission before waiting for transcript commitment", async () => {
    const f = await createFixture("off");
    try {
      f.say("Check A.");
      await f.drain();
      f.callbacks.onSpeechActivity?.({ utteranceId: "b", state: "candidate" });
      const completion = f.consult.waitForPendingInput?.(f.consult.abortSignal);
      expect(completion).toBeInstanceOf(Promise);
      let released = false;
      void completion?.then(() => {
        released = true;
      });
      f.say("Also check B.", "b");
      // The decoder's terminal notification is earlier than queue admission.
      f.callbacks.onProcessing?.({ utteranceId: "b", state: "transcribed" });
      await f.drain();
      expect(released).toBe(false);
      expect(f.control).toHaveBeenCalledOnce();
      f.control.mock.calls[0]?.[1]?.(true);
      await completion;
      expect(released).toBe(true);
      expect(f.consult.waitForPendingInput?.()).toBeUndefined();
      expect(f.tts).not.toHaveBeenCalled();
      // Native commitment can now run. The same consult returns the new answer.
      f.admitted.resolve(accepted);
      f.done.resolve({ text: "A and B are ready." });
      await f.drain();
      expect(f.consultAgent).toHaveBeenCalledOnce();
      expect(f.tts).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "A and B are ready." }),
      );
    } finally {
      f.admitted.resolve(accepted);
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it("lets accepted B advance the native loop while C still awaits FIFO admission", async () => {
    const f = await createFixture("off");
    try {
      f.say("A");
      await f.drain();
      f.callbacks.onSpeechActivity?.({ utteranceId: "b", state: "candidate" });
      f.callbacks.onSpeechActivity?.({ utteranceId: "c", state: "candidate" });
      const firstWait = f.consult.waitForPendingInput?.();
      f.say("B", "b");
      f.say("C", "c");
      await f.drain();
      expect(f.control).toHaveBeenCalledTimes(1);
      f.control.mock.calls[0]?.[1]?.(true);
      await firstWait;
      // Wake on B alone; a wait-for-all would deadlock B's commitment behind C.
      const secondWait = f.consult.waitForPendingInput?.();
      expect(secondWait).toBeInstanceOf(Promise);
      f.admitted.resolve(accepted);
      await f.drain();
      expect(f.control.mock.calls.map(([text]) => text)).toEqual(["B", "C"]);
      await secondWait;
      f.done.resolve({ text: "A, B and C." });
      await f.drain();
      expect(f.consultAgent).toHaveBeenCalledOnce();
    } finally {
      f.admitted.resolve(accepted);
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });
});
