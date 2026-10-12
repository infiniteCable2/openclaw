import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { toErrorObject } from "../../infra/errors.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import { startSpeechSession } from "./session.js";
import type { SpeechAgentConsultParams } from "./types.js";

function createProvider(prepareSession: RealtimeTranscriptionProviderPlugin["prepareSession"]) {
  return {
    id: "prepared-stt",
    label: "Prepared STT",
    isConfigured: () => true,
    prepareSession,
    createSession: vi.fn(),
  } satisfies RealtimeTranscriptionProviderPlugin;
}

const config = {
  audioFormat: "pcm16-24khz" as const,

  agentId: "reader",
  transcriptionProvider: "prepared-stt",
  providers: { "prepared-stt": {} },
};

async function createWaitingAudioFixture(): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-waiting-"));
  const filePath = path.join(dir, "waiting.wav");
  const pcm = Buffer.alloc(960, 1);
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(wav, 44);
  await writeFile(filePath, wav);
  await chmod(filePath, 0o600);
  return { dir, filePath };
}

describe("meeting transcript granularity", () => {
  it.each([undefined, "segment", "utterance"] as const)(
    "preserves serial consults with %s transcript granularity",
    async (transcriptGranularity) => {
      vi.useFakeTimers();
      let handle: Awaited<ReturnType<typeof startSpeechSession>> | undefined;
      const completion = createDeferred<{ text: string; delivered: true }>();
      try {
        const provider = { ...createProvider(undefined), transcriptGranularity };
        let transcribe: ((text: string) => void) | undefined;
        provider.createSession.mockImplementation((request) => {
          transcribe = request.onTranscript;
          return {
            connect: async () => undefined,
            sendAudio() {},
            close() {},
            isConnected: () => true,
          };
        });
        const consultAgent = vi
          .fn(async (_params: SpeechAgentConsultParams) => ({
            text: "",
            delivered: true as const,
          }))
          .mockImplementationOnce(() => completion.promise);
        handle = await startSpeechSession({
          config,
          fullConfig: {},
          runtime: {} as PluginRuntime,
          surface: { displayName: "Test meeting", logScope: "test", sessionIdPrefix: "test" },
          sessionId: "transcript-granularity",
          transport: {
            onFatal() {},
            startInput() {},
            writeOutput: async () => undefined,
            clearOutput: async () => undefined,
            stop: async () => undefined,
            dispose: async () => undefined,
          },
          providers: [provider],
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          consultAgent,
        });
        if (!transcribe) {
          throw new Error("Expected transcription callback");
        }
        transcribe("First contribution.");
        await vi.advanceTimersByTimeAsync(0);
        if (transcriptGranularity === "utterance") {
          expect(consultAgent).toHaveBeenCalledOnce();
        } else {
          expect(consultAgent).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(450);
          transcribe("Continued contribution.");
          await vi.advanceTimersByTimeAsync(899);
          expect(consultAgent).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(consultAgent).toHaveBeenCalledOnce();
        }
        const firstQuestion =
          transcriptGranularity === "utterance"
            ? "First contribution."
            : "First contribution.\nContinued contribution.";
        expect(consultAgent.mock.calls[0]?.[0].args).toEqual(
          expect.objectContaining({ question: firstQuestion }),
        );
        transcribe("Next contribution.");
        await vi.advanceTimersByTimeAsync(900);
        expect(consultAgent).toHaveBeenCalledOnce();
        completion.resolve({ text: "", delivered: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(consultAgent).toHaveBeenCalledTimes(2);
        expect(consultAgent.mock.calls[1]?.[0].args).toEqual(
          expect.objectContaining({ question: "Next contribution." }),
        );
      } finally {
        completion.resolve({ text: "", delivered: true });
        await handle?.stop();
        vi.useRealTimers();
      }
    },
  );
});

async function createControlledStreamingEngine() {
  const provider = createProvider(undefined);
  let callbacks: Parameters<RealtimeTranscriptionProviderPlugin["createSession"]>[0] | undefined;
  provider.createSession.mockImplementation((params) => {
    callbacks = params;
    return {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: () => true,
    };
  });
  const streams: Array<{
    controller: ReadableStreamDefaultController<Uint8Array>;
    signal?: AbortSignal;
    release: ReturnType<typeof vi.fn>;
    firstRead: Promise<void>;
    secondRead: Promise<void>;
  }> = [];
  const synthesize = vi.fn(async (params: { signal?: AbortSignal }) => {
    const release = vi.fn(async () => undefined);
    const readRequests = [createDeferred(), createDeferred()];
    const state = {
      signal: params.signal,
      release,
      firstRead: readRequests[0]!.promise,
      secondRead: readRequests[1]!.promise,
    };
    const audioStream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          streams.push({ ...state, controller });
        },
        pull() {
          readRequests.shift()?.resolve();
        },
      },
      { highWaterMark: 0 },
    );
    return { success: true, audioStream, release, sampleRate: 24_000, outputFormat: "pcm" };
  });
  const completion = createDeferred<{ text: string; delivered: true }>();
  let consult: SpeechAgentConsultParams | undefined;
  const consultAgent = vi.fn((params: SpeechAgentConsultParams) => {
    consult = params;
    return completion.promise;
  });
  const writeOutput = vi.fn(async (_audio: Buffer) => undefined);
  const clearOutput = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handle = await startSpeechSession({
    config: { ...config, responseStreaming: "sentence" },
    fullConfig: {},
    runtime: { tts: { streamTextToSpeechTelephony: synthesize } } as unknown as PluginRuntime,
    surface: {
      displayName: "Test meeting",
      logScope: "test meeting",
      sessionIdPrefix: "test-meeting",
    },
    sessionId: "controlled-stream",
    transport: {
      onFatal: vi.fn(),
      startInput: vi.fn(),
      writeOutput,
      clearOutput,
      stop: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    },
    logger,
    providers: [provider],
    consultAgent,
  });
  expectDefined(
    callbacks?.onTranscript,
    "Expected the prepared transcript callback",
  )("Please answer my question.");
  await vi.waitFor(() => expect(consultAgent).toHaveBeenCalledOnce(), { timeout: 2_000 });
  return {
    handle,
    streams,
    callbacks,
    synthesize,
    writeOutput,
    clearOutput,
    consultAgent,
    logger,
    streamAt(index: number) {
      const stream = streams[index];
      if (!stream) {
        throw new Error(`Expected prepared speech stream ${index}`);
      }
      return stream;
    },
    speech: consult!.onSpeakableText!,
    async stop() {
      completion.resolve({ text: "", delivered: true });
      await handle.stop();
    },
  };
}

describe("startSpeechSession streaming output", () => {
  it("does not resume prepared or later sentences after a transcribed caller turn", async () => {
    const fixture = await createControlledStreamingEngine();
    try {
      await fixture.speech({ type: "chunk", text: "This is the first sentence." });
      await vi.waitFor(() => expect(fixture.streams).toHaveLength(1));
      fixture.streamAt(0).controller.enqueue(Uint8Array.from([1, 0]));
      await vi.waitFor(() => expect(fixture.writeOutput).toHaveBeenCalledOnce());
      await fixture.speech({ type: "chunk", text: "This second sentence is prepared already." });
      await vi.waitFor(() => expect(fixture.streams).toHaveLength(2));
      fixture.streamAt(1).controller.enqueue(Uint8Array.from([2, 0]));
      fixture.callbacks?.onSpeechStart?.();
      fixture.callbacks?.onProcessing?.({ utteranceId: "barge-in", state: "speech-confirmed" });
      expect(fixture.clearOutput).not.toHaveBeenCalled();
      fixture.callbacks?.onTranscript?.("A new caller request.", { utteranceId: "barge-in" });
      await vi.waitFor(() => {
        expect(fixture.streamAt(0).release).toHaveBeenCalledOnce();
        expect(fixture.streamAt(1).release).toHaveBeenCalledOnce();
      });
      await fixture.speech({ type: "chunk", text: "This third sentence must be ignored." });
      expect(fixture.synthesize).toHaveBeenCalledTimes(2);
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
      expect(fixture.clearOutput).toHaveBeenCalledOnce();
      expect(fixture.streams.every((stream) => stream.signal?.aborted)).toBe(true);
    } finally {
      await fixture.stop();
    }
  });

  it("fences an already fulfilled read when a transcribed caller turn races its continuation", async () => {
    const fixture = await createControlledStreamingEngine();
    try {
      await fixture.speech({ type: "chunk", text: "This sentence is still playing." });
      await vi.waitFor(() => expect(fixture.streams).toHaveLength(1));
      const stream = fixture.streamAt(0);
      // With no prefetch, each pull admits an actual pending read. Wait before
      // enqueueing so the first chunk cannot merely enter the stream's queue.
      await stream.firstRead;
      stream.controller.enqueue(Uint8Array.from([1, 0]));
      await stream.secondRead;
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
      // Enqueue fulfills read(), then cancellation precedes its await continuation.
      stream.controller.enqueue(Uint8Array.from([2, 0]));
      fixture.callbacks?.onSpeechStart?.();
      fixture.callbacks?.onProcessing?.({ utteranceId: "barge-in", state: "speech-confirmed" });
      fixture.callbacks?.onTranscript?.("A new caller request.", { utteranceId: "barge-in" });
      await vi.waitFor(() => expect(stream.release).toHaveBeenCalledOnce());
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
    } finally {
      await fixture.stop();
    }
  });

  it("records delayed assistant echoes without interrupting their playback", async () => {
    const fixture = await createControlledStreamingEngine();
    const text = "These are the details of your requested answer.";
    try {
      await fixture.speech({ type: "chunk", text });
      await vi.waitFor(() => expect(fixture.streams).toHaveLength(1));
      const stream = fixture.streamAt(0);
      stream.controller.enqueue(Uint8Array.from([1, 0]));
      await vi.waitFor(() => expect(fixture.writeOutput).toHaveBeenCalledOnce());
      expectDefined(
        fixture.callbacks?.onTranscript,
        "Expected the prepared transcript callback",
      )(text);
      expect(stream.signal?.aborted).toBe(false);
      expect(fixture.clearOutput).not.toHaveBeenCalled();
      stream.controller.enqueue(Uint8Array.from([2, 0]));
      stream.controller.close();
      await fixture.speech({ type: "done", text });
      await vi.waitFor(() => expect(stream.release).toHaveBeenCalledOnce());
      expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      expect(fixture.consultAgent).toHaveBeenCalledOnce();
      expect(
        fixture.handle
          .getHealth()
          .recentTalkEvents?.filter((event) => event.type === "transcript.done"),
      ).toHaveLength(2);
    } finally {
      await fixture.stop();
    }
  });

  it("publishes final text before audio and retains that event if the sink fails", async () => {
    const fixture = await createControlledStreamingEngine();
    try {
      fixture.writeOutput.mockRejectedValueOnce(new Error("sink closed"));
      await fixture.speech({ type: "done", text: "This final answer is available." });
      expect(
        fixture.handle
          .getHealth()
          .recentTalkEvents?.some((event) => event.type === "output.text.done"),
      ).toBe(true);
      expect(fixture.writeOutput).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(fixture.streams).toHaveLength(1));
      fixture.streamAt(0).controller.enqueue(Uint8Array.from([1, 0]));
      await vi.waitFor(() =>
        expect(fixture.logger.warn).toHaveBeenCalledWith(expect.stringContaining("sink closed")),
      );
      const events = fixture.handle.getHealth().recentTalkEvents!.map((event) => event.type);
      expect(events.indexOf("output.text.done")).toBeLessThan(
        events.indexOf("output.audio.started"),
      );
      expect(events.slice(-2)).toEqual(["output.audio.done", "turn.ended"]);
    } finally {
      await fixture.stop();
    }
  });
  it("starts sentence TTS before the agent consult completes and records one logical answer", async () => {
    let onTranscript: ((text: string) => void) | undefined;
    const provider = createProvider(undefined);
    provider.createSession.mockImplementation((params) => {
      onTranscript = params.onTranscript;
      return {
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        close: vi.fn(),
        isConnected: () => true,
      };
    });
    const synthesize = vi.fn<PluginRuntime["tts"]["streamTextToSpeechTelephony"]>(async () => ({
      success: true,
      audioStream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 0, 2, 0]));
          controller.close();
        },
      }),
      outputFormat: "pcm" as const,
      sampleRate: 24_000,
    }));
    let finishConsult: ((result: { text: string; delivered: true }) => void) | undefined;
    const consultAgent = vi.fn(
      (_params: SpeechAgentConsultParams) =>
        new Promise<{ text: string; delivered: true }>((resolve) => {
          finishConsult = resolve;
        }),
    );
    const handle = await startSpeechSession({
      config: {
        ...config,
        responseStreaming: "sentence",
      },
      fullConfig: {} as never,
      runtime: { tts: { streamTextToSpeechTelephony: synthesize } } as unknown as PluginRuntime,
      surface: {
        displayName: "Test meeting",
        logScope: "test meeting",
        sessionIdPrefix: "test-meeting",
      },
      sessionId: "meeting-stream",
      transport: {
        onFatal: vi.fn(),
        startInput: vi.fn(),
        writeOutput: vi.fn(async () => undefined),
        clearOutput: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providers: [provider],
      consultAgent,
    });

    onTranscript?.("Bitte antworte ausführlich.");
    await vi.waitFor(() => expect(consultAgent).toHaveBeenCalledOnce(), { timeout: 2_000 });
    const consult = consultAgent.mock.calls[0]?.[0];
    if (!consult) {
      throw new Error("Expected meeting consult params");
    }
    const speech = {
      tagged: true as const,
      text: "Erster Satz.",
      expression: { parts: [{ text: "Erster Satz." }] },
    };
    const localServiceAdmission = {
      generation: "synthetic-worker",
      signal: new AbortController().signal,
    };
    const expectedSpeechSelection = {
      provider: "example",
      model: "prepared-model",
      voice: "prepared-voice",
    };
    await consult.onSpeakableText?.({
      type: "chunk",
      text: speech.text,
      speech,
      localServiceAdmission,
      expectedSpeechSelection,
    });
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());
    expect(synthesize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: speech.text,
        overrides: { expression: speech.expression },
        localServiceAdmission,
        expectedSpeechSelection,
      }),
    );
    expect(synthesize.mock.calls[0]?.[0].localServiceAdmission).toBe(localServiceAdmission);
    expect(synthesize.mock.calls[0]?.[0].expectedSpeechSelection).toBe(expectedSpeechSelection);

    await consult.onSpeakableText?.({ type: "chunk", text: "Zweiter Satz." });
    await consult.onSpeakableText?.({
      type: "done",
      text: "Erster Satz. Zweiter Satz.",
    });
    finishConsult?.({ text: "Erster Satz. Zweiter Satz.", delivered: true });

    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
    expect(synthesize.mock.calls[1]?.[0]).not.toHaveProperty("localServiceAdmission");
    expect(synthesize.mock.calls[1]?.[0]).not.toHaveProperty("expectedSpeechSelection");
    expect(synthesize.mock.calls[1]?.[0]).not.toHaveProperty("overrides");
    await vi.waitFor(() => {
      const assistantEntries = handle
        .getHealth()
        .recentRealtimeTranscript.filter((entry) => entry.role === "assistant");
      expect(assistantEntries.map((entry) => entry.text)).toEqual(["Erster Satz. Zweiter Satz."]);
    });
    await handle.stop();
  });

  it("prepares exactly one sentence ahead while preserving playback order", async () => {
    let onTranscript: ((text: string) => void) | undefined;
    const provider = createProvider(undefined);
    provider.createSession.mockImplementation((params) => {
      onTranscript = params.onTranscript;
      return {
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        close: vi.fn(),
        isConnected: () => true,
      };
    });
    const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const synthesize = vi.fn(async () => ({
      success: true,
      audioStream: new ReadableStream<Uint8Array>({
        start(controller) {
          streamControllers.push(controller);
          controller.enqueue(Uint8Array.from([streamControllers.length, 0]));
        },
      }),
      outputFormat: "pcm" as const,
      sampleRate: 24_000,
    }));
    let consult: SpeechAgentConsultParams | undefined;
    let finishConsult: ((result: { text: string; delivered: true }) => void) | undefined;
    const consultAgent = vi.fn(
      (params: SpeechAgentConsultParams) =>
        new Promise<{ text: string; delivered: true }>((resolve) => {
          consult = params;
          finishConsult = resolve;
        }),
    );
    const writes: Buffer[] = [];
    const handle = await startSpeechSession({
      config: {
        ...config,
        responseStreaming: "sentence",
      },
      fullConfig: {} as never,
      runtime: { tts: { streamTextToSpeechTelephony: synthesize } } as unknown as PluginRuntime,
      surface: {
        displayName: "Test meeting",
        logScope: "test meeting",
        sessionIdPrefix: "test-meeting",
      },
      sessionId: "meeting-one-ahead",
      transport: {
        onFatal: vi.fn(),
        startInput: vi.fn(),
        writeOutput: vi.fn(async (audio: Buffer) => {
          writes.push(Buffer.from(audio));
        }),
        clearOutput: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providers: [provider],
      consultAgent,
    });

    onTranscript?.("Bitte drei Sätze.");
    await vi.waitFor(() => expect(consultAgent).toHaveBeenCalledOnce(), { timeout: 2_000 });
    await consult?.onSpeakableText?.({ type: "chunk", text: "Satz eins." });
    await vi.waitFor(() => {
      expect(synthesize).toHaveBeenCalledOnce();
      expect(writes).toHaveLength(1);
    });

    await consult?.onSpeakableText?.({ type: "chunk", text: "Satz zwei." });
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
    await consult?.onSpeakableText?.({ type: "chunk", text: "Satz drei." });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(synthesize).toHaveBeenCalledTimes(2);

    streamControllers[0]?.close();
    await vi.waitFor(() => {
      expect(writes).toHaveLength(2);
      expect(synthesize).toHaveBeenCalledTimes(3);
    });
    streamControllers[1]?.close();
    await vi.waitFor(() => expect(writes).toHaveLength(3));
    streamControllers[2]?.close();
    await consult?.onSpeakableText?.({
      type: "done",
      text: "Satz eins. Satz zwei. Satz drei.",
    });
    finishConsult?.({ text: "Satz eins. Satz zwei. Satz drei.", delivered: true });

    await vi.waitFor(() => {
      expect(writes.map((audio) => audio[0])).toEqual([1, 2, 3]);
    });
    await handle.stop();
  });

  it("clears configured waiting audio before the first synthesized speech frame", async () => {
    const fixture = await createWaitingAudioFixture();
    let handle: Awaited<ReturnType<typeof startSpeechSession>> | undefined;
    try {
      let onTranscript: ((text: string) => void) | undefined;
      const provider = createProvider(undefined);
      provider.createSession.mockImplementation((params) => {
        onTranscript = params.onTranscript;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          close: vi.fn(),
          isConnected: () => true,
        };
      });
      const synthesize = vi.fn(async () => ({
        success: true,
        audioStream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([9, 0, 8, 0]));
            controller.close();
          },
        }),
        outputFormat: "pcm" as const,
        sampleRate: 24_000,
      }));
      let consult: SpeechAgentConsultParams | undefined;
      let finishConsult: ((result: { text: string; delivered: true }) => void) | undefined;
      const consultAgent = vi.fn(
        (params: SpeechAgentConsultParams) =>
          new Promise<{ text: string; delivered: true }>((resolve) => {
            consult = params;
            finishConsult = resolve;
          }),
      );
      const writeOutput = vi.fn(async (_audio: Buffer) => undefined);
      const clearOutput = vi.fn(async () => undefined);
      handle = await startSpeechSession({
        config: {
          ...config,
          responseStreaming: "sentence",
          waitingAudio: { filePath: fixture.filePath, startDelayMs: 0, volume: 0.14 },
        },
        fullConfig: {} as never,
        runtime: { tts: { streamTextToSpeechTelephony: synthesize } } as unknown as PluginRuntime,
        surface: {
          displayName: "Test meeting",
          logScope: "test meeting",
          sessionIdPrefix: "test-meeting",
        },
        sessionId: "meeting-waiting-audio",
        transport: {
          onFatal: vi.fn(),
          startInput: vi.fn(),
          writeOutput,
          clearOutput,
          stop: vi.fn(async () => undefined),
          dispose: vi.fn(async () => undefined),
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        providers: [provider],
        consultAgent,
      });

      onTranscript?.("Bitte antworte.");
      await vi.waitFor(() => expect(consultAgent).toHaveBeenCalledOnce(), { timeout: 2_000 });
      await vi.waitFor(
        () => expect(writeOutput.mock.calls.some(([audio]) => audio.byteLength === 960)).toBe(true),
        { timeout: 2_000 },
      );

      await consult?.onSpeakableText?.({ type: "chunk", text: "Die Antwort ist bereit." });
      await vi.waitFor(() => {
        expect(synthesize).toHaveBeenCalledOnce();
        expect(writeOutput.mock.calls.some(([audio]) => audio.byteLength === 4)).toBe(true);
      });
      const speechWriteIndex = writeOutput.mock.calls.findIndex(
        ([audio]) => audio.byteLength === 4,
      );
      const speechWriteOrder = writeOutput.mock.invocationCallOrder[speechWriteIndex] ?? 0;
      expect(clearOutput).toHaveBeenCalledOnce();
      expect(clearOutput.mock.invocationCallOrder[0]).toBeLessThan(speechWriteOrder);

      await consult?.onSpeakableText?.({ type: "done", text: "Die Antwort ist bereit." });
      finishConsult?.({ text: "Die Antwort ist bereit.", delivered: true });
    } finally {
      await handle?.stop();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("invalidates later streamed chunks after a confirmed caller interruption", async () => {
    let onTranscript: ((text: string) => void) | undefined;
    const provider = createProvider(undefined);
    provider.createSession.mockImplementation((params) => {
      onTranscript = params.onTranscript;
      return {
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        close: vi.fn(),
        isConnected: () => true,
      };
    });
    const synthesize = vi.fn(
      (params: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => reject(toErrorObject(params.signal?.reason, "Speech synthesis aborted")),
            {
              once: true,
            },
          );
        }),
    );
    let firstConsult: SpeechAgentConsultParams | undefined;
    let finishFirst: ((result: { text: string; delivered: true }) => void) | undefined;
    const consultAgent = vi
      .fn((params: SpeechAgentConsultParams) => {
        firstConsult = params;
        return new Promise<{ text: string; delivered: true }>((resolve) => {
          finishFirst = resolve;
        });
      })
      .mockImplementationOnce((params: SpeechAgentConsultParams) => {
        firstConsult = params;
        return new Promise<{ text: string; delivered: true }>((resolve) => {
          finishFirst = resolve;
        });
      });
    const handle = await startSpeechSession({
      config: {
        ...config,
        responseStreaming: "sentence",
      },
      fullConfig: {} as never,
      runtime: { tts: { streamTextToSpeechTelephony: synthesize } } as unknown as PluginRuntime,
      surface: {
        displayName: "Test meeting",
        logScope: "test meeting",
        sessionIdPrefix: "test-meeting",
      },
      sessionId: "meeting-barge-in",
      transport: {
        supportsFullDuplexInput: true,
        onFatal: vi.fn(),
        startInput: vi.fn(),
        writeOutput: vi.fn(async () => undefined),
        clearOutput: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providers: [provider],
      consultAgent,
    });

    onTranscript?.("Erste Frage.");
    await vi.waitFor(() => expect(consultAgent).toHaveBeenCalledOnce(), { timeout: 2_000 });
    await firstConsult?.onSpeakableText?.({ type: "chunk", text: "Erster Antwortsatz." });
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());

    onTranscript?.("Unterbrechung mit neuer Frage.");
    await firstConsult?.onSpeakableText?.({ type: "chunk", text: "Darf nicht mehr erklingen." });
    finishFirst?.({ text: "Erster Antwortsatz. Darf nicht mehr erklingen.", delivered: true });

    await vi.waitFor(() => expect(consultAgent).toHaveBeenCalledTimes(2));
    expect(synthesize).toHaveBeenCalledOnce();
    await handle.stop();
  });

  it("writes ordered TTS segments as they arrive and releases the stream", async () => {
    const release = vi.fn(async () => undefined);
    const beginOutput = vi.fn();
    const writes: Buffer[] = [];
    const provider = createProvider(undefined);
    provider.createSession.mockReturnValue({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: () => true,
    });
    const handle = await startSpeechSession({
      config,
      fullConfig: {} as never,
      runtime: {
        tts: {
          streamTextToSpeechTelephony: vi.fn(async () => ({
            success: true,
            audioStream: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Uint8Array.from([1, 0, 2, 0]));
                controller.enqueue(Uint8Array.from([3, 0, 4, 0]));
                controller.close();
              },
            }),
            outputFormat: "pcm",
            sampleRate: 24_000,
            release,
          })),
        },
      } as unknown as PluginRuntime,
      surface: {
        displayName: "Test meeting",
        logScope: "test meeting",
        sessionIdPrefix: "test-meeting",
      },
      sessionId: "meeting-1",
      transport: {
        onFatal: vi.fn(),
        startInput: vi.fn(),
        beginOutput,
        writeOutput: vi.fn(async (audio: Buffer) => {
          writes.push(Buffer.from(audio));
        }),
        clearOutput: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providers: [provider],
      consultAgent: vi.fn(async () => ({ text: "unused" })),
    });

    handle.speak("Zwei frühe Segmente.");
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0])]);
    expect(beginOutput).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await handle.stop();
  });

  it("waits for a caller transcript before canceling pre-playback synthesis", async () => {
    const clearOutput = vi.fn(async () => undefined);
    let onSpeechStart: (() => void) | undefined;
    let onTranscript: ((text: string) => void) | undefined;
    let onProcessing: Parameters<
      RealtimeTranscriptionProviderPlugin["createSession"]
    >[0]["onProcessing"];
    let synthesisSignal: AbortSignal | undefined;
    const provider = createProvider(undefined);
    provider.createSession.mockImplementation((params) => {
      onSpeechStart = params.onSpeechStart;
      onTranscript = params.onTranscript;
      onProcessing = params.onProcessing;
      return {
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        close: vi.fn(),
        isConnected: () => true,
      };
    });
    const synthesize = vi.fn(
      (params: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          synthesisSignal = params.signal;
          params.signal?.addEventListener(
            "abort",
            () => reject(toErrorObject(params.signal?.reason, "Speech synthesis aborted")),
            {
              once: true,
            },
          );
        }),
    );
    const handle = await startSpeechSession({
      config,
      fullConfig: {} as never,
      runtime: { tts: { streamTextToSpeechTelephony: synthesize } } as unknown as PluginRuntime,
      surface: {
        displayName: "Test meeting",
        logScope: "test meeting",
        sessionIdPrefix: "test-meeting",
      },
      sessionId: "meeting-1",
      transport: {
        supportsFullDuplexInput: true,
        onFatal: vi.fn(),
        startInput: vi.fn(),
        writeOutput: vi.fn(async () => undefined),
        clearOutput,
        stop: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providers: [provider],
      consultAgent: vi.fn(async () => ({ text: "unused" })),
    });

    handle.speak("Die Synthese läuft noch.");
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());
    onSpeechStart?.();
    onProcessing?.({ utteranceId: "barge-in", state: "speech-confirmed" });
    expect(synthesisSignal?.aborted).toBe(false);

    onTranscript?.("Bestätigter neuer Beitrag.");
    await vi.waitFor(() => {
      expect(synthesisSignal?.aborted).toBe(true);
      expect(clearOutput).toHaveBeenCalledOnce();
    });
    await handle.stop();
  });

  it("keeps isolated full-duplex input flowing while assistant playback is active", async () => {
    const sendAudio = vi.fn();
    let receiveInput: ((audio: Buffer) => void) | undefined;
    const provider = createProvider(undefined);
    provider.createSession.mockReturnValue({
      connect: vi.fn(async () => undefined),
      sendAudio,
      close: vi.fn(),
      isConnected: () => true,
    });
    const writeOutput = vi.fn(async () => undefined);
    const handle = await startSpeechSession({
      config,
      fullConfig: {} as never,
      runtime: {
        tts: {
          streamTextToSpeechTelephony: vi.fn(async () => ({
            success: true,
            audioStream: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Uint8Array.from([1, 0, 2, 0]));
                controller.close();
              },
            }),
            outputFormat: "pcm",
            sampleRate: 24_000,
          })),
        },
      } as unknown as PluginRuntime,
      surface: {
        displayName: "Test meeting",
        logScope: "test meeting",
        sessionIdPrefix: "test-meeting",
      },
      sessionId: "meeting-1",
      transport: {
        supportsFullDuplexInput: true,
        onFatal: vi.fn(),
        startInput: vi.fn((onAudio) => {
          receiveInput = onAudio;
        }),
        writeOutput,
        clearOutput: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providers: [provider],
      consultAgent: vi.fn(async () => ({ text: "unused" })),
    });

    handle.speak("Ausgabe mit gleichzeitigem Eingang.");
    await vi.waitFor(() => expect(writeOutput).toHaveBeenCalledOnce());
    receiveInput?.(Buffer.alloc(480, 1));

    expect(sendAudio).toHaveBeenCalledOnce();
    await handle.stop();
  });
});
