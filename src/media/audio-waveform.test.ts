import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runFfmpeg: vi.fn(),
}));

vi.mock("./ffmpeg-exec.js", () => ({
  runFfmpeg: mocks.runFfmpeg,
}));

import { getAudioWaveform } from "./audio-waveform.js";

function pcm16le(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

describe("audio waveform", () => {
  beforeEach(() => {
    mocks.runFfmpeg.mockReset().mockImplementation(async (args: string[]) => {
      const outputPath = args.at(-1);
      if (!outputPath) {
        throw new Error("missing waveform output path");
      }
      await fs.writeFile(outputPath, pcm16le([0, 16_384, -32_768, 8_192]));
      return "";
    });
  });

  it("decodes bounded audio through ffmpeg in a private workspace", async () => {
    await expect(
      getAudioWaveform({
        audioBuffer: Buffer.from("ogg"),
        inputFileName: "voice.ogg",
        inputContentType: "audio/ogg",
      }),
    ).resolves.toEqual([0, 512, 1024, 256]);
    expect(mocks.runFfmpeg).toHaveBeenCalledOnce();
    expect(mocks.runFfmpeg.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["-f", "s16le", "-ac", "1", "-ar", "8000"]),
    );
  });

  it("limits long audio to 200 buckets while retaining a final peak", async () => {
    mocks.runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      await fs.writeFile(args.at(-1)!, pcm16le([...Array<number>(400).fill(0), -32_768]));
      return "";
    });
    const waveform = await getAudioWaveform({ audioBuffer: Buffer.from("ogg") });
    expect(waveform).toHaveLength(200);
    expect(waveform.slice(0, -1)).toEqual(Array(199).fill(0));
    expect(waveform.at(-1)).toBe(1024);
  });
});
