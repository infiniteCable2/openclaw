import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import { pcmToMulaw } from "../talk/audio-codec.js";
import { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import {
  convertMeetingTtsAudioForBridge,
  type MeetingRealtimeAudioFormat,
} from "./realtime-audio-format.js";

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
  audioFormat?: MeetingRealtimeAudioFormat;
}) {
  const controllerReady = createDeferred<ReadableStreamDefaultController<Uint8Array>>();
  const firstRead = createDeferred();
  const secondRead = createDeferred();
  const reads = [firstRead, secondRead];
  const cancelled = vi.fn();
  const release = vi.fn(async () => undefined);
  const beginOutput = vi.fn();
  const writeOutput = vi.fn(async (_audio: Buffer) => undefined);
  let speechStart: (() => void) | undefined;
  const provider: RealtimeTranscriptionProviderPlugin = {
    id: "stream-test-stt",
    label: "Stream test STT",
    isConfigured: () => true,
    createSession(callbacks) {
      speechStart = callbacks.onSpeechStart;
      return {
        connect: async () => undefined,
        close() {},
        sendAudio() {},
        isConnected: () => true,
      };
    },
  };
  const handle = await startMeetingAgentRealtimeEngine({
    config: {
      chrome: { audioFormat: params.audioFormat ?? "pcm16-24khz" },
      realtime: {
        strategy: "agent",
        transcriptionProvider: provider.id,
        providers: { [provider.id]: {} },
      },
    },
    fullConfig: {},
    runtime: {
      tts: {
        streamTextToSpeechTelephony: async () => ({
          success: true,
          sampleRate: params.sampleRate,
          outputFormat: params.outputFormat,
          release,
          audioStream: new ReadableStream<Uint8Array>(
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
          ),
        }),
      },
    } as unknown as PluginRuntime,
    platform: { displayName: "Test meeting", logScope: "test", sessionIdPrefix: "test" },
    meetingSessionId: "tts-stream-conversion",
    transport: {
      onFatal() {},
      startInput() {},
      beginOutput,
      writeOutput,
      clearOutput: async () => undefined,
      stop: async () => undefined,
      dispose: async () => undefined,
    },
    providers: [provider],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    consultAgent: async () => ({ text: "unused" }),
  });
  handle.speak("A synthetic audio stream.");
  const controller = await controllerReady.promise;
  await firstRead.promise;
  return {
    handle,
    controller,
    secondRead: secondRead.promise,
    release,
    cancelled,
    beginOutput,
    writeOutput,
    speechStart,
  };
}

describe("meeting TTS stream conversion", () => {
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
      const fixture = await createAudioStreamFixture(params);
      const pcm = createPcm(params.sampleRate);
      const source = params.outputFormat === "mulaw" ? pcmToMulaw(pcm) : pcm;
      const expected = convertMeetingTtsAudioForBridge(
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
        const writes = fixture.writeOutput.mock.calls.map(([audio]) => audio);
        expect(Buffer.concat(writes)).toEqual(expected);
        expect(writes.every((audio) => audio.length > 0)).toBe(true);
        if (params.audioFormat === "pcm16-24khz") {
          expect(writes.every((audio) => audio.length % 2 === 0)).toBe(true);
        }
        expect(fixture.beginOutput).toHaveBeenCalledOnce();
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
      fixture.controller.close();
      await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
      expect(fixture.writeOutput).toHaveBeenCalledExactlyOnceWith(
        convertMeetingTtsAudioForBridge(source, 16_000, "pcm16-24khz", "pcm"),
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
        const complete = convertMeetingTtsAudioForBridge(source, 16_000, "pcm16-24khz", "pcm");
        expect(output.length).toBeGreaterThan(0);
        expect(output.length).toBeLessThan(complete.length);
        expect(output).toEqual(complete.subarray(0, output.length));
        const writesBeforeCancellation = fixture.writeOutput.mock.calls.length;
        if (cancellation === "stop") {
          await fixture.handle.stop();
        } else {
          fixture.speechStart?.();
        }
        await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
        expect(fixture.cancelled).toHaveBeenCalledOnce();
        expect(fixture.writeOutput).toHaveBeenCalledTimes(writesBeforeCancellation);
      } finally {
        await fixture.handle.stop();
      }
    },
  );
});
