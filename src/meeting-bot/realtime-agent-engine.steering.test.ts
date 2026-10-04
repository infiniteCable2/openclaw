import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceAgentControlResult } from "../talk/agent-run-control.js";
import { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import type { MeetingAgentConsultParams } from "./realtime-engine.js";

async function createFixture(streaming: "off" | "sentence" = "sentence") {
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
      inputAudioIsolated: true,
      clearOutput: async () => {},
      stop: async () => {},
      dispose: async () => {},
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    providers: [provider],
    consultAgent,
  });
  return {
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
    say: (text: string) => {
      if (!callbacks.onTranscript) {
        throw new Error("Missing transcript handler");
      }
      callbacks.onTranscript(text);
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
