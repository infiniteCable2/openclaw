import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import { pcmToMulaw } from "../audio-codec.js";
import { convertSpeechTtsAudio, type SpeechAudioFormat } from "./audio-format.js";
import { startSpeechSession } from "./session.js";

function createPcm(sampleRate: number, sampleCount = 257): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index++) {
    pcm.writeInt16LE(
      Math.round(Math.sin((index * 2 * Math.PI * 440) / sampleRate) * 20_000),
      index * 2,
    );
  }
  return pcm;
}

async function createAudioStreamFixture(params: {
  sampleRate: number;
  outputFormat: string;
  audioFormat?: SpeechAudioFormat;
  consultAgent?: Parameters<typeof startSpeechSession>[0]["consultAgent"];
  onActivity?: Parameters<typeof startSpeechSession>[0]["onActivity"];
  invalidResult?: "missing-stream" | "invalid-rate" | "locked-stream";
  holdPreparation?: Promise<void>;
}) {
  const controllerReady = createDeferred<ReadableStreamDefaultController<Uint8Array>>();
  const firstRead = createDeferred();
  const secondRead = createDeferred();
  const reads = [firstRead, secondRead];
  const cancelled = vi.fn();
  const released = createDeferred();
  let retainedReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const release = vi.fn(async () => {
    retainedReader?.releaseLock();
    retainedReader = undefined;
    released.resolve();
  });
  const beginOutput = vi.fn();
  const dispose = vi.fn(async () => undefined);
  const writeOutput = vi.fn(async (_audio: Buffer) => undefined);
  const synthesisStarted = vi.fn();
  let speechStart: (() => void) | undefined;
  let speechProcessing: Parameters<
    RealtimeTranscriptionProviderPlugin["createSession"]
  >[0]["onProcessing"];
  let speechTranscript: Parameters<
    RealtimeTranscriptionProviderPlugin["createSession"]
  >[0]["onTranscript"];
  const provider: RealtimeTranscriptionProviderPlugin = {
    id: "stream-test-stt",
    label: "Stream test STT",
    isConfigured: () => true,
    createSession(callbacks) {
      speechStart = callbacks.onSpeechStart;
      speechProcessing = callbacks.onProcessing;
      speechTranscript = callbacks.onTranscript;
      return {
        connect: async () => undefined,
        close() {},
        sendAudio() {},
        isConnected: () => true,
      };
    },
  };
  const handle = await startSpeechSession({
    config: {
      audioFormat: params.audioFormat ?? "pcm16-24khz",

      transcriptionProvider: provider.id,
      providers: { [provider.id]: {} },
    },
    fullConfig: {},
    runtime: {
      tts: {
        streamTextToSpeechTelephony: async () => {
          synthesisStarted();
          const stream = new ReadableStream<Uint8Array>(
            {
              start(controller) {
                controllerReady.resolve(controller);
              },
              pull() {
                reads.shift()?.resolve();
              },
              cancel: cancelled,
            },
            { highWaterMark: 0 },
          );
          if (params.invalidResult === "locked-stream") {
            retainedReader = stream.getReader();
          }
          if (params.holdPreparation) {
            await params.holdPreparation;
          }
          return {
            success: true,
            sampleRate: params.invalidResult === "invalid-rate" ? 0 : params.sampleRate,
            outputFormat: params.outputFormat,
            release,
            audioStream: params.invalidResult === "missing-stream" ? undefined : stream,
          };
        },
      },
    } as unknown as PluginRuntime,
    surface: { displayName: "Test meeting", logScope: "test", sessionIdPrefix: "test" },
    sessionId: "tts-stream-conversion",
    transport: {
      onFatal() {},
      startInput() {},
      beginOutput,
      writeOutput,
      clearOutput: async () => undefined,
      stop: async () => undefined,
      dispose,
    },
    providers: [provider],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    consultAgent: params.consultAgent ?? (async () => ({ text: "unused" })),
    onActivity: params.onActivity,
  });
  handle.speak("A synthetic audio stream.");
  const controller = await controllerReady.promise;
  if (!params.invalidResult && !params.holdPreparation) {
    await firstRead.promise;
  }
  return {
    handle,
    controller,
    secondRead: secondRead.promise,
    release,
    released: released.promise,
    cancelled,
    beginOutput,
    dispose,
    writeOutput,
    synthesisStarted,
    speechStart,
    speechProcessing,
    speechTranscript,
  };
}

describe("meeting TTS stream conversion", () => {
  it("keeps the stream hold while a source cancellation is still pending", async () => {
    const fixture = await createAudioStreamFixture({ sampleRate: 24_000, outputFormat: "pcm" });
    const cancellationStarted = createDeferred();
    const cancellation = createDeferred();
    fixture.cancelled.mockImplementationOnce(async () => {
      cancellationStarted.resolve();
      await cancellation.promise;
    });
    const closing = fixture.handle.stop();
    try {
      await cancellationStarted.promise;
      expect(fixture.release).not.toHaveBeenCalled();
      expect(fixture.dispose).not.toHaveBeenCalled();
      cancellation.resolve();
      await closing;
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(fixture.dispose).toHaveBeenCalledOnce();
    } finally {
      cancellation.resolve();
      await closing;
      await fixture.handle.stop();
    }
  });

  it("cancels a late prepared stream before releasing its provider hold", async () => {
    const preparation = createDeferred();
    const fixture = await createAudioStreamFixture({
      sampleRate: 24_000,
      outputFormat: "pcm",
      holdPreparation: preparation.promise,
    });
    const closing = fixture.handle.stop();
    try {
      preparation.resolve();
      await closing;
      expect(fixture.cancelled).toHaveBeenCalledOnce();
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(fixture.cancelled.mock.invocationCallOrder[0]).toBeLessThan(
        fixture.release.mock.invocationCallOrder[0]!,
      );
      expect(fixture.writeOutput).not.toHaveBeenCalled();
      expect(fixture.beginOutput).not.toHaveBeenCalled();
    } finally {
      preparation.resolve();
      await closing;
      await fixture.handle.stop();
    }
  });

  it.each(["cancel", "unlock"] as const)(
    "keeps the provider hold when reader %s is unconfirmed",
    async (operation) => {
      const fixture = await createAudioStreamFixture({ sampleRate: 24_000, outputFormat: "pcm" });
      const failure = new Error("synthetic reader cleanup failure");
      let unlock: { mockRestore(): void } | undefined;
      if (operation === "cancel") {
        fixture.cancelled.mockRejectedValueOnce(failure);
      } else {
        unlock = vi
          .spyOn(ReadableStreamDefaultReader.prototype, "releaseLock")
          .mockImplementationOnce(() => {
            throw failure;
          });
      }
      try {
        await expect(fixture.handle.stop()).rejects.toThrow(
          "Speech session resources did not close",
        );
        expect(fixture.release).not.toHaveBeenCalled();
        expect(fixture.dispose).not.toHaveBeenCalled();
        expect(
          fixture.handle.getHealth().recentTalkEvents?.map((event) => event.type),
        ).not.toContain("session.closed");
        await fixture.handle.stop();
        expect(fixture.release).toHaveBeenCalledOnce();
        expect(fixture.dispose).toHaveBeenCalledOnce();
        await fixture.handle.stop();
        expect(fixture.release).toHaveBeenCalledOnce();
      } finally {
        unlock?.mockRestore();
        await fixture.handle.stop();
      }
    },
  );

  it.each(["active", "stopped"] as const)(
    "retains failed %s stream cleanup until a later stop confirms release",
    async (state) => {
      const fixture = await createAudioStreamFixture({ sampleRate: 24_000, outputFormat: "pcm" });
      const failedRelease = createDeferred();
      const cleanupFailure = new Error("synthetic stream release failure");
      fixture.release.mockImplementationOnce(async () => {
        failedRelease.resolve();
        throw cleanupFailure;
      });
      try {
        let stopping: Promise<void>;
        if (state === "active") {
          fixture.controller.enqueue(createPcm(24_000));
          fixture.controller.close();
          await failedRelease.promise;
          stopping = fixture.handle.stop();
        } else {
          stopping = fixture.handle.stop();
        }
        await expect(stopping).rejects.toThrow("Speech session resources did not close");
        expect(fixture.release).toHaveBeenCalledOnce();
        expect(fixture.dispose).not.toHaveBeenCalled();
        expect(
          fixture.handle.getHealth().recentTalkEvents?.map((event) => event.type),
        ).not.toContain("session.closed");
        const writes = fixture.writeOutput.mock.calls.length;
        await fixture.handle.stop();
        await fixture.handle.stop();
        expect(fixture.release).toHaveBeenCalledTimes(2);
        expect(fixture.dispose).toHaveBeenCalledOnce();
        expect(fixture.writeOutput).toHaveBeenCalledTimes(writes);
        expect(
          fixture.handle
            .getHealth()
            .recentTalkEvents?.filter((event) => event.type === "session.closed"),
        ).toHaveLength(1);
      } finally {
        await fixture.handle.stop();
      }
    },
  );

  it.each(["missing-stream", "invalid-rate", "locked-stream"] as const)(
    "releases acquired TTS resources when playback cannot start (%s)",
    async (invalidResult) => {
      const fixture = await createAudioStreamFixture({
        sampleRate: 24_000,
        outputFormat: "pcm",
        invalidResult,
      });
      try {
        await fixture.released;
        expect(fixture.release).toHaveBeenCalledOnce();
        expect(fixture.writeOutput).not.toHaveBeenCalled();
        expect(fixture.beginOutput).not.toHaveBeenCalled();
        expect(fixture.cancelled).toHaveBeenCalledTimes(invalidResult === "invalid-rate" ? 1 : 0);
        const nextReleased = createDeferred();
        const releaseResources = fixture.release.getMockImplementation()!;
        fixture.release.mockImplementationOnce(async () => {
          await releaseResources();
          nextReleased.resolve();
        });
        fixture.handle.speak("Another synthetic reply.");
        await nextReleased.promise;
        expect(fixture.synthesisStarted).toHaveBeenCalledTimes(2);
        expect(fixture.release).toHaveBeenCalledTimes(2);
      } finally {
        await fixture.handle.stop();
      }
      expect(fixture.release).toHaveBeenCalledTimes(2);
    },
  );

  it("retains interrupted speech when cancellation races the first sink handoff", async () => {
    vi.useFakeTimers();
    const handedOff = createDeferred();
    const writeStarted = createDeferred();
    const released = createDeferred();
    const fixture = await createAudioStreamFixture({ sampleRate: 24_000, outputFormat: "pcm" });
    fixture.writeOutput.mockImplementationOnce(async () => {
      writeStarted.resolve();
      await handedOff.promise;
    });
    fixture.release.mockImplementationOnce(async () => {
      released.resolve();
      return undefined;
    });
    try {
      fixture.controller.enqueue(createPcm(24_000));
      await writeStarted.promise;
      fixture.speechTranscript?.("Additional caller context.");
      handedOff.resolve();
      await released.promise;
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
      expect(fixture.handle.getHealth().recentRealtimeTranscript).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          text: "A synthetic audio stream.",
          audioDelivery: "interrupted",
        }),
      );
      expect(fixture.handle.getHealth().recentRealtimeTranscript).toContainEqual(
        expect.objectContaining({ role: "user", text: "Additional caller context." }),
      );
    } finally {
      handedOff.resolve();
      await fixture.handle.stop();
      vi.useRealTimers();
    }
  });

  it.each(["result", "failure"] as const)(
    "settles interrupted tool work without resurrecting its buffered %s",
    async (outcome) => {
      vi.useFakeTimers();
      const firstResult = createDeferred<{ text: string }>();
      const secondStarted = createDeferred();
      const secondResult = createDeferred<{ text: string }>();
      const consultAgent = vi
        .fn()
        .mockImplementationOnce(() => firstResult.promise)
        .mockImplementationOnce(() => {
          secondStarted.resolve();
          return secondResult.promise;
        });
      const fixture = await createAudioStreamFixture({
        sampleRate: 24_000,
        outputFormat: "pcm",
        consultAgent,
      });
      try {
        fixture.speechTranscript?.("First request.");
        await vi.advanceTimersByTimeAsync(900);
        expect(consultAgent).toHaveBeenCalledOnce();
        fixture.speechTranscript?.("Replacement request.");
        if (outcome === "result") {
          firstResult.resolve({ text: "Stale spoken result." });
        } else {
          firstResult.reject(new Error("Stale failure"));
        }
        await secondStarted.promise;
        expect(fixture.synthesisStarted).toHaveBeenCalledOnce();
        const transcript = [
          expect.objectContaining({
            role: "assistant",
            text: "A synthetic audio stream.",
            audioDelivery: "unplayed",
          }),
          expect.objectContaining({ role: "user", text: "First request." }),
          expect.objectContaining({ role: "user", text: "Replacement request." }),
          ...(outcome === "result"
            ? [
                expect.objectContaining({
                  role: "assistant",
                  text: "Stale spoken result.",
                  audioDelivery: "unplayed",
                }),
              ]
            : []),
        ];
        expect(consultAgent).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            args: expect.objectContaining({ question: "Replacement request." }),
            transcript,
          }),
        );
        expect(fixture.writeOutput).not.toHaveBeenCalled();
        expect(fixture.handle.getHealth().recentRealtimeTranscript).toEqual(transcript);
        secondResult.resolve({ text: "" });
      } finally {
        secondResult.resolve({ text: "" });
        await fixture.handle.stop();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { sampleRate: 16_000, outputFormat: "pcm", audioFormat: "pcm16-24khz", chunkBytes: 17 },
    { sampleRate: 16_000, outputFormat: "pcm", audioFormat: "pcm16-24khz", chunkBytes: 34 },
    { sampleRate: 24_000, outputFormat: "pcm", audioFormat: "pcm16-24khz", chunkBytes: 17 },
    { sampleRate: 16_000, outputFormat: "pcm", audioFormat: "g711-ulaw-8khz", chunkBytes: 17 },
    { sampleRate: 8_000, outputFormat: "mulaw", audioFormat: "pcm16-24khz", chunkBytes: 17 },
    { sampleRate: 8_000, outputFormat: "mulaw", audioFormat: "g711-ulaw-8khz", chunkBytes: 17 },
  ] as const)(
    "preserves complete audio across $chunkBytes-byte $outputFormat chunks at $sampleRate Hz to $audioFormat",
    async (params) => {
      const onActivity = vi.fn();
      const fixture = await createAudioStreamFixture({ ...params, onActivity });
      const pcm = createPcm(params.sampleRate);
      const source = params.outputFormat === "mulaw" ? pcmToMulaw(pcm) : pcm;
      const expected = convertSpeechTtsAudio(
        source,
        params.sampleRate,
        params.audioFormat,
        params.outputFormat,
      );
      try {
        for (let offset = 0; offset < source.length; offset += params.chunkBytes) {
          fixture.controller.enqueue(source.subarray(offset, offset + params.chunkBytes));
        }
        fixture.controller.close();
        await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
        expect(fixture.cancelled).not.toHaveBeenCalled();
        const writes = fixture.writeOutput.mock.calls.map(([audio]) => audio);
        expect(Buffer.concat(writes)).toEqual(expected);
        expect(writes.every((audio) => audio.length > 0)).toBe(true);
        if (params.audioFormat === "pcm16-24khz") {
          expect(writes.every((audio) => audio.length % 2 === 0)).toBe(true);
        }
        expect(fixture.beginOutput).toHaveBeenCalledOnce();
        expect(onActivity).toHaveBeenCalledWith("speaking");
        expect(onActivity.mock.calls.filter(([activity]) => activity === "speaking")).toHaveLength(
          1,
        );
      } finally {
        await fixture.handle.stop();
      }
    },
  );

  it("starts playback only when samples are available and flushes a short stream once at EOF", async () => {
    const fixture = await createAudioStreamFixture({ sampleRate: 16_000, outputFormat: "pcm" });
    const source = createPcm(16_000, 4);
    try {
      fixture.controller.enqueue(source);
      await fixture.secondRead;
      expect(fixture.writeOutput).not.toHaveBeenCalled();
      expect(fixture.beginOutput).not.toHaveBeenCalled();
      expect(fixture.handle.getHealth().recentRealtimeTranscript).toEqual([
        expect.objectContaining({
          role: "assistant",
          text: "A synthetic audio stream.",
          audioDelivery: "unplayed",
        }),
      ]);
      fixture.controller.close();
      await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
      expect(fixture.writeOutput).toHaveBeenCalledExactlyOnceWith(
        convertSpeechTtsAudio(source, 16_000, "pcm16-24khz", "pcm"),
      );
      expect(fixture.beginOutput).toHaveBeenCalledOnce();
    } finally {
      await fixture.handle.stop();
    }
  });

  it.each(["stop", "barge-in"] as const)(
    "discards the resampler tail on %s",
    async (cancellation) => {
      const fixture = await createAudioStreamFixture({ sampleRate: 16_000, outputFormat: "pcm" });
      const source = createPcm(16_000);
      try {
        fixture.controller.enqueue(source);
        await fixture.secondRead;
        const output = Buffer.concat(fixture.writeOutput.mock.calls.map(([audio]) => audio));
        const complete = convertSpeechTtsAudio(source, 16_000, "pcm16-24khz", "pcm");
        expect(output.length).toBeGreaterThan(0);
        expect(fixture.handle.getHealth().recentRealtimeTranscript).toEqual([
          expect.objectContaining({ role: "assistant", audioDelivery: "started" }),
        ]);
        expect(output.length).toBeLessThan(complete.length);
        expect(output).toEqual(complete.subarray(0, output.length));
        const writesBeforeCancellation = fixture.writeOutput.mock.calls.length;
        if (cancellation === "stop") {
          await fixture.handle.stop();
        } else {
          fixture.speechStart?.();
          fixture.speechProcessing?.({ utteranceId: "barge-in", state: "speech-confirmed" });
          fixture.speechTranscript?.("A new caller request.", { utteranceId: "barge-in" });
        }
        await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
        expect(fixture.cancelled).toHaveBeenCalledOnce();
        expect(fixture.writeOutput).toHaveBeenCalledTimes(writesBeforeCancellation);
        expect(fixture.handle.getHealth().recentRealtimeTranscript).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            text: "A synthetic audio stream.",
            audioDelivery: "interrupted",
          }),
        );
      } finally {
        await fixture.handle.stop();
      }
    },
  );
});
