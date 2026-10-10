import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpeechWaitingAudioPlayback, prepareSpeechWaitingAudio } from "./waiting-audio.js";

// This native launcher leaves Node Promise timers real; bind only their clock
// to Sinon for this owner's void-valued delays and retain cancellation through
// the existing abort-race owner.
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  const { racePromiseWithAbortSignal } = await import("../../infra/abort-signal.js");
  return {
    ...actual,
    async setTimeout(
      delay?: Parameters<typeof actual.setTimeout>[0],
      _value?: void,
      options?: Parameters<typeof actual.setTimeout>[2],
    ): Promise<void> {
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      try {
        return await racePromiseWithAbortSignal(
          () =>
            new Promise<void>((resolve) => {
              const scheduledTimer = globalThis.setTimeout(resolve, delay);
              timer = scheduledTimer;
              if (options?.ref === false) {
                scheduledTimer.unref();
              }
            }),
          options?.signal,
        );
      } finally {
        globalThis.clearTimeout(timer);
      }
    },
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true })));
});

function pcm16MonoWav(samples: number[], sampleRate = 16_000): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(wav, 44);
  return wav;
}

async function writeTrustedWav(content: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-waiting-audio-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "waiting.wav");
  await writeFile(filePath, content);
  await chmod(filePath, 0o600);
  return filePath;
}

describe("meeting waiting audio", () => {
  it("loads, scales, and converts a bounded mono PCM16 WAV", async () => {
    const filePath = await writeTrustedWav(pcm16MonoWav([10_000, -10_000, 5_000, -5_000], 24_000));

    const prepared = await prepareSpeechWaitingAudio(
      { filePath, startDelayMs: 1_200, volume: 0.5 },
      "pcm16-24khz",
    );

    expect(prepared).toMatchObject({ frameBytes: 960, startDelayMs: 1_200 });
    expect(prepared?.pcm.byteLength).toBeGreaterThan(0);
    expect(prepared?.pcm.readInt16LE(0)).toBe(5_000);
  });

  it("rejects an invalid configured audio file before call admission", async () => {
    const filePath = await writeTrustedWav(Buffer.from("not a wave"));

    await expect(
      prepareSpeechWaitingAudio({ filePath, startDelayMs: 0, volume: 0.14 }, "pcm16-24khz"),
    ).rejects.toThrow("RIFF/WAVE");
  });

  it("paces looping frames and joins them at the caller-owned stop boundary", async () => {
    vi.useFakeTimers();
    const writeOutput = vi.fn(async (_frame: Buffer) => undefined);
    const clearOutput = vi.fn(async () => undefined);
    const onError = vi.fn();
    const playback = createSpeechWaitingAudioPlayback({
      audio: { pcm: Buffer.alloc(1_200, 1), frameBytes: 960, startDelayMs: 0, resumeDelayMs: 800 },
      transport: { writeOutput, clearOutput },
      isStopped: () => false,
      onError,
    });
    try {
      playback.schedule();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersToNextTimerAsync();
      expect(writeOutput).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(19);
      expect(writeOutput).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(writeOutput).toHaveBeenCalledTimes(2);
      expect(writeOutput.mock.calls.map(([frame]) => frame.byteLength)).toEqual([960, 960]);
      await playback.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(clearOutput).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      expect(writeOutput).toHaveBeenCalledTimes(2);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await playback.stop();
    }
  });
});
