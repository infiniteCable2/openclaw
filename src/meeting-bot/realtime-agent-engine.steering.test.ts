import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceAgentControlResult } from "../talk/agent-run-control.js";
import { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import type { MeetingAgentConsultParams } from "./realtime-engine.js";

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
  const control = vi.fn((_text: string) => admitted.promise);
  let consult!: MeetingAgentConsultParams;
  const consultAgent = vi.fn(async (params: MeetingAgentConsultParams) => {
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
  const handle = await startMeetingAgentRealtimeEngine({
    config: {
      chrome: { audioFormat: "pcm16-24khz" },
      realtime: {
        strategy: "agent",
        transcriptionProvider: provider.id,
        responseStreaming: streaming,
        providers: { [provider.id]: {} },
      },
    },
    fullConfig: {},
    runtime: { tts: { streamTextToSpeechTelephony: tts } } as unknown as PluginRuntime,
    platform: { displayName: "Test", logScope: "test", sessionIdPrefix: "test" },
    meetingSessionId: "steering",
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
        let next: MeetingAgentConsultParams | undefined;
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
        expect(f.writeOutput).toHaveBeenCalledOnce();
      } finally {
        f.done.resolve({ text: "" });
        await f.handle.stop();
      }
    },
  );

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
      let next: MeetingAgentConsultParams | undefined;
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
      let next: MeetingAgentConsultParams | undefined;
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
      expect(f.control).toHaveBeenCalledExactlyOnceWith("Also check the printer.");
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
        expect(f.consult.includePrecedingInputAnswers?.()).toBe(false);
        f.say("Also check the printer.");
        await f.drain();
        expect(f.control).toHaveBeenCalledExactlyOnceWith("Also check the printer.");
        expect(f.consult.abortSignal?.aborted).toBe(false);
        expect(f.consult.includePrecedingInputAnswers?.()).toBe(true);
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
      let next: MeetingAgentConsultParams | undefined;
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
});
