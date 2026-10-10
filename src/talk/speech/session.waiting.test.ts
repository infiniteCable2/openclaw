import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import type { RealtimeTranscriptionSessionCreateRequest } from "../../realtime-transcription/provider-types.js";
import { startSpeechSession } from "./session.js";
import type { SpeechAgentConsultParams } from "./types.js";
import { createSpeechWaitingAudioPlayback } from "./waiting-audio.js";

vi.mock("./waiting-audio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./waiting-audio.js")>()),
  prepareSpeechWaitingAudio: vi.fn(async () => undefined),
  createSpeechWaitingAudioPlayback: vi.fn(() => ({
    schedule: vi.fn(),
    stop: vi.fn(async () => undefined),
  })),
}));

async function setup(options?: {
  initialGreeting?: { text: string; audio: Buffer };
  remoteReady?: Promise<void>;
  fullDuplexEchoWindow?: boolean;
}) {
  let callbacks!: RealtimeTranscriptionSessionCreateRequest;
  let consult!: SpeechAgentConsultParams;
  let audio!: ReadableStreamDefaultController<Uint8Array>;
  const completion = createDeferred<{ text: string; delivered: true }>();
  const readerStarted = createDeferred();
  const synthesis = vi.fn(async () => ({
    success: true,
    sampleRate: 24_000,
    outputFormat: "pcm",
    audioStream: new ReadableStream<Uint8Array>(
      {
        start(controller) {
          audio = controller;
        },
        pull() {
          readerStarted.resolve();
        },
      },
      { highWaterMark: 0 },
    ),
  }));
  const provider: RealtimeTranscriptionProviderPlugin = {
    id: "test-stt",
    label: "Test",
    transcriptGranularity: "utterance",
    isConfigured: () => true,
    createSession(request) {
      callbacks = request;
      return { connect: async () => {}, sendAudio() {}, close() {}, isConnected: () => true };
    },
  };
  const writeOutput = vi.fn(async (_audio: Buffer) => undefined);
  const setOutputGate = vi.fn(async () => undefined);
  const transportStop = vi.fn(async () => undefined);
  const transportDispose = vi.fn(async () => undefined);
  const consultAgent = vi.fn((request: SpeechAgentConsultParams) => {
    consult = request;
    return completion.promise;
  });
  const handle = await startSpeechSession({
    config: {
      audioFormat: "pcm16-24khz",

      transcriptionProvider: "test-stt",
      responseStreaming: "sentence",
      providers: {},
    },
    fullConfig: {},
    runtime: { tts: { streamTextToSpeechTelephony: synthesis } } as unknown as PluginRuntime,
    surface: { displayName: "Test", logScope: "test", sessionIdPrefix: "test" },
    sessionId: "test-call",
    ...(options?.initialGreeting ? { initialGreeting: options.initialGreeting } : {}),
    transport: {
      inputAudioIsolated: options?.fullDuplexEchoWindow !== true,
      ...(options?.fullDuplexEchoWindow ? { supportsFullDuplexInput: true } : {}),
      ...(options?.fullDuplexEchoWindow ? { setOutputGate } : {}),
      onFatal() {},
      startInput() {},
      ...(options?.remoteReady ? { waitForRemoteAudioReady: () => options.remoteReady! } : {}),
      writeOutput,
      clearOutput: async () => {},
      stop: transportStop,
      dispose: transportDispose,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    providers: [provider],
    consultAgent,
  });
  const playback = vi.mocked(createSpeechWaitingAudioPlayback).mock.results.at(-1)!.value;
  return {
    callbacks,
    handle,
    playback,
    writeOutput,
    setOutputGate,
    transportStop,
    transportDispose,
    consultAgent,
    synthesis,
    readerStarted,
    process(
      utteranceId: string,
      state: Parameters<NonNullable<typeof callbacks.onProcessing>>[0]["state"],
    ) {
      callbacks.onProcessing?.({ utteranceId, state });
    },
    chunk(text: string) {
      return consult.onSpeakableText?.({ type: "chunk", text });
    },
    audio() {
      return audio;
    },
    finish() {
      completion.resolve({ text: "", delivered: true });
    },
    async close() {
      completion.resolve({ text: "", delivered: true });
      await handle.stop();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("speech-confirmed waiting audio", () => {
  it("does not schedule greeting playback after stop settles remote readiness", async () => {
    const remoteReady = createDeferred();
    const f = await setup({
      initialGreeting: { text: "Hello, caller.", audio: Buffer.from([1, 0]) },
      remoteReady: remoteReady.promise,
    });
    f.transportStop.mockImplementationOnce(async () => {
      remoteReady.resolve();
    });
    try {
      await f.handle.stop();
      expect(f.writeOutput).not.toHaveBeenCalled();
      expect(f.transportDispose).toHaveBeenCalledOnce();
      expect(
        f.handle.getHealth().recentTalkEvents?.filter((event) => event.type === "session.closed"),
      ).toHaveLength(1);
    } finally {
      remoteReady.resolve();
      await f.close();
    }
  });

  it("joins an admitted greeting write before disposing its transport", async () => {
    const f = await setup({
      initialGreeting: { text: "Hello, caller.", audio: Buffer.from([1, 0]) },
    });
    const writing = createDeferred();
    const writeStarted = createDeferred();
    const captureStopped = createDeferred();
    f.writeOutput.mockImplementationOnce(async () => {
      writeStarted.resolve();
      await writing.promise;
    });
    f.transportStop.mockImplementationOnce(async () => {
      captureStopped.resolve();
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);
    await writeStarted.promise;
    const closing = f.handle.stop();
    try {
      await captureStopped.promise;
      expect(f.transportDispose).not.toHaveBeenCalled();
      expect(f.handle.getHealth().recentTalkEvents?.map((event) => event.type)).not.toContain(
        "session.closed",
      );
      writing.resolve();
      await closing;
      expect(f.transportDispose).toHaveBeenCalledOnce();
      expect(f.writeOutput).toHaveBeenCalledOnce();
    } finally {
      writing.resolve();
      await closing;
      await f.close();
    }
  });

  it("resumes after the quiet gap without waiting for the full-duplex echo tail", async () => {
    const f = await setup({ fullDuplexEchoWindow: true });
    try {
      f.callbacks.onTranscript?.("Please check that.");
      await vi.advanceTimersByTimeAsync(0);
      await f.chunk("I am checking.");
      await f.readerStarted.promise;
      f.audio().enqueue(Uint8Array.from([7, 0]));
      f.audio().close();
      await vi.advanceTimersByTimeAsync(0);
      f.playback.schedule.mockClear();
      await vi.advanceTimersByTimeAsync(799);
      expect(f.playback.schedule).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(101);
      expect(f.playback.schedule).toHaveBeenCalledOnce();
      expect(f.playback.schedule).toHaveBeenCalledWith(0);
    } finally {
      await f.close();
    }
  });

  it("holds waiting music while native output is paused and briefly after release", async () => {
    const f = await setup({ fullDuplexEchoWindow: true });
    try {
      f.callbacks.onTranscript?.("Please check that.");
      await vi.advanceTimersByTimeAsync(0);
      await f.chunk("I am checking.");
      await f.readerStarted.promise;
      f.audio().enqueue(Uint8Array.from([7, 0]));
      f.audio().close();
      await vi.advanceTimersByTimeAsync(0);
      f.playback.schedule.mockClear();
      f.callbacks.onSpeechActivity?.({ utteranceId: "candidate", state: "candidate" });
      f.callbacks.onSpeechActivity?.({ utteranceId: "candidate", state: "sustained" });
      await vi.advanceTimersByTimeAsync(3_500);
      expect(f.playback.schedule).not.toHaveBeenCalled();
      expect(f.setOutputGate).toHaveBeenCalledWith("paused");
      f.callbacks.onSpeechActivity?.({ utteranceId: "candidate", state: "rejected" });
      await vi.advanceTimersByTimeAsync(2_900);
      expect(f.playback.schedule).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(f.playback.schedule).toHaveBeenCalledOnce();
      expect(f.playback.schedule).toHaveBeenCalledWith(0);
    } finally {
      await f.close();
    }
  });

  it("does not play a prepared greeting until remote audio is ready and a short delay passes", async () => {
    const remoteReady = createDeferred();
    const f = await setup({
      initialGreeting: { text: "Hello, caller.", audio: Buffer.from([1, 0]) },
      remoteReady: remoteReady.promise,
    });
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(f.writeOutput).not.toHaveBeenCalled();
      remoteReady.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(149);
      expect(f.writeOutput).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      expect(f.writeOutput).toHaveBeenCalledOnce();
      expect(f.writeOutput).toHaveBeenCalledWith(Buffer.from([1, 0]));
    } finally {
      remoteReady.resolve();
      await f.close();
    }
  });

  it("cancels a prepared greeting when caller speech starts before remote audio is ready", async () => {
    const remoteReady = createDeferred();
    const f = await setup({
      initialGreeting: { text: "Hello, caller.", audio: Buffer.from([1, 0]) },
      remoteReady: remoteReady.promise,
    });
    try {
      f.callbacks.onSpeechStart?.();
      remoteReady.resolve();
      await vi.advanceTimersByTimeAsync(200);
      expect(f.writeOutput).not.toHaveBeenCalled();
    } finally {
      remoteReady.resolve();
      await f.close();
    }
  });

  it("ends the call if the caller's audio track never becomes ready", async () => {
    const remoteReady = createDeferred();
    const f = await setup({
      initialGreeting: { text: "Hello, caller.", audio: Buffer.from([1, 0]) },
      remoteReady: remoteReady.promise,
    });
    remoteReady.reject(new Error("remote audio timed out"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.writeOutput).not.toHaveBeenCalled();
    expect(f.transportStop).toHaveBeenCalledOnce();
    await f.close();
  });

  it("resumes only after a quiet gap between TTS segments while the agent is working", async () => {
    const f = await setup();
    try {
      f.callbacks.onTranscript?.("Please answer.");
      await vi.advanceTimersByTimeAsync(0);
      await f.chunk("First segment.");
      await f.readerStarted.promise;
      f.audio().enqueue(Uint8Array.from([7, 0]));
      f.audio().close();
      await vi.advanceTimersByTimeAsync(0);
      f.playback.schedule.mockClear();
      await vi.advanceTimersByTimeAsync(799);
      expect(f.playback.schedule).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(101);
      expect(f.playback.schedule).toHaveBeenCalledOnce();
      expect(f.playback.schedule).toHaveBeenCalledWith(0);
      await f.chunk("Second segment.");
      await vi.advanceTimersByTimeAsync(0);
      f.audio().enqueue(Uint8Array.from([8, 0]));
      f.audio().close();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.playback.stop).toHaveBeenCalled();
      expect(f.writeOutput).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });

  it("drains waiting music before a later TTS segment resumes PCM", async () => {
    const f = await setup();
    const preparation = createDeferred<Awaited<ReturnType<typeof f.synthesis>>>();
    const drain = createDeferred();
    let audio!: ReadableStreamDefaultController<Uint8Array>;
    const second = {
      success: true,
      sampleRate: 24_000,
      outputFormat: "pcm",
      audioStream: new ReadableStream<Uint8Array>({
        start(controller) {
          audio = controller;
        },
      }),
    };
    try {
      f.callbacks.onTranscript?.("First question.");
      await vi.advanceTimersByTimeAsync(0);
      await f.chunk("First segment.");
      await f.readerStarted.promise;
      f.audio().enqueue(Uint8Array.from([7, 0]));
      f.audio().close();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.writeOutput).toHaveBeenCalledOnce();
      f.synthesis.mockImplementationOnce(() => preparation.promise);
      await f.chunk("Second segment.");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.synthesis).toHaveBeenCalledTimes(2);

      f.callbacks.onSpeechStart?.();
      f.process("2", "started");
      f.process("2", "speech-confirmed");
      expect(f.playback.schedule).toHaveBeenCalledTimes(2);
      f.playback.stop.mockClear();
      f.playback.stop.mockImplementation(() => drain.promise);
      preparation.resolve(second);
      audio.enqueue(Uint8Array.from([8, 0]));
      audio.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.playback.stop).toHaveBeenCalledOnce();
      expect(f.writeOutput).toHaveBeenCalledOnce();
      drain.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.writeOutput).toHaveBeenCalledTimes(2);
    } finally {
      drain.resolve();
      preparation.resolve(second);
      await f.close();
    }
  });

  it.each(["pending", "empty", "failed", "cancelled", "transcribed", "superseded"] as const)(
    "reconsiders blocked speech confirmation after TTS drains only while %s",
    async (state) => {
      const f = await setup();
      try {
        f.callbacks.onTranscript?.("First question.");
        await vi.advanceTimersByTimeAsync(0);
        await f.chunk("First answer.");
        await f.readerStarted.promise;
        f.audio().enqueue(Uint8Array.from([7, 0]));
        await vi.advanceTimersByTimeAsync(0);
        expect(f.writeOutput).toHaveBeenCalledOnce();
        f.callbacks.onSpeechStart?.();
        f.process("2", "started");
        f.process("2", "speech-confirmed");
        f.playback.schedule.mockClear();
        if (state === "superseded") {
          f.callbacks.onSpeechStart?.();
        } else if (state !== "pending") {
          f.process("2", state);
        }
        f.audio().close();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.playback.schedule).toHaveBeenCalledTimes(state === "pending" ? 1 : 0);
        expect(f.consultAgent).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    },
  );

  it("does not stop newer confirmed input when an older consult returns no speech", async () => {
    const f = await setup();
    try {
      f.process("1", "started");
      f.process("1", "speech-confirmed");
      f.callbacks.onTranscript?.("First question.", { utteranceId: "1" });
      f.process("1", "transcribed");
      await vi.advanceTimersByTimeAsync(0);
      f.callbacks.onSpeechStart?.();
      f.process("2", "started");
      f.process("2", "speech-confirmed");
      expect(f.playback.schedule).toHaveBeenCalledTimes(2);
      f.playback.stop.mockClear();
      f.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.playback.stop).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("cannot start another loop during the first speech frame's waiting-audio drain", async () => {
    const f = await setup();
    const drain = createDeferred();
    try {
      f.process("1", "started");
      f.process("1", "speech-confirmed");
      f.callbacks.onTranscript?.("First question.", { utteranceId: "1" });
      f.process("1", "transcribed");
      await vi.advanceTimersByTimeAsync(0);
      await f.chunk("First answer.");
      await f.readerStarted.promise;
      f.playback.stop.mockImplementation(() => drain.promise);
      f.audio().enqueue(Uint8Array.from([7, 0]));
      f.audio().close();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.playback.stop).toHaveBeenCalledOnce();
      expect(f.writeOutput).not.toHaveBeenCalled();
      f.callbacks.onSpeechStart?.();
      f.process("2", "started");
      f.process("2", "speech-confirmed");
      expect(f.playback.schedule).toHaveBeenCalledOnce();
      drain.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.writeOutput).toHaveBeenCalledOnce();
    } finally {
      drain.resolve();
      await f.close();
    }
  });

  it("starts before the transcript, continues through TTS preparation, and clears before PCM", async () => {
    const f = await setup();
    try {
      f.callbacks.onSpeechStart?.();
      f.process("1", "started");
      expect(f.playback.schedule).not.toHaveBeenCalled();
      f.process("1", "speech-confirmed");
      expect(f.playback.schedule).toHaveBeenCalledOnce();
      expect(f.consultAgent).not.toHaveBeenCalled();
      f.playback.stop.mockClear();
      f.callbacks.onTranscript?.("Please answer.", { utteranceId: "1" });
      f.process("1", "transcribed");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.consultAgent).toHaveBeenCalledOnce();
      expect(f.playback.schedule).toHaveBeenCalledOnce();
      expect(f.playback.stop).not.toHaveBeenCalled();
      await f.chunk("Here is the answer.");
      await f.readerStarted.promise;
      expect(f.playback.stop).not.toHaveBeenCalled();
      f.audio().enqueue(Uint8Array.from([7, 0, 8, 0]));
      f.audio().close();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.writeOutput).toHaveBeenCalledOnce();
      expect(f.playback.stop).toHaveBeenCalledOnce();
      expect(f.playback.stop.mock.invocationCallOrder[0]).toBeLessThan(
        f.writeOutput.mock.invocationCallOrder[0]!,
      );
    } finally {
      await f.close();
    }
  });

  it.each(["empty", "failed", "cancelled"] as const)(
    "stops on %s without invoking an agent",
    async (outcome) => {
      const f = await setup();
      try {
        f.process("1", "started");
        f.process("1", "speech-confirmed");
        expect(f.playback.schedule).toHaveBeenCalledOnce();
        f.process("1", outcome);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.playback.stop).toHaveBeenCalledOnce();
        expect(f.consultAgent).not.toHaveBeenCalled();
        f.process("1", "speech-confirmed");
        expect(f.playback.schedule).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    },
  );

  it("ignores obsolete confirmations and terminals without affecting another call", async () => {
    const a = await setup();
    const b = await setup();
    try {
      for (const f of [a, b]) {
        f.process("1", "started");
      }
      a.callbacks.onSpeechStart?.();
      a.process("1", "speech-confirmed");
      expect(a.playback.schedule).not.toHaveBeenCalled();
      b.process("1", "speech-confirmed");
      expect(b.playback.schedule).toHaveBeenCalledOnce();
      a.process("2", "started");
      a.process("2", "speech-confirmed");
      a.playback.stop.mockClear();
      a.process("1", "empty");
      expect(a.playback.stop).not.toHaveBeenCalled();
      expect(b.playback.stop).not.toHaveBeenCalled();
      await a.close();
      a.process("3", "started");
      a.process("3", "speech-confirmed");
      expect(a.playback.schedule).toHaveBeenCalledOnce();
      expect(b.playback.stop).not.toHaveBeenCalled();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("does not keep music running after synthesis fails", async () => {
    const f = await setup();
    try {
      f.synthesis.mockRejectedValueOnce(new Error("synthetic TTS failure"));
      f.process("1", "started");
      f.process("1", "speech-confirmed");
      f.callbacks.onTranscript?.("Please answer.", { utteranceId: "1" });
      f.process("1", "transcribed");
      await vi.advanceTimersByTimeAsync(0);
      f.playback.stop.mockClear();
      await f.chunk("The answer.");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.playback.stop).toHaveBeenCalledOnce();
      expect(f.writeOutput).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
