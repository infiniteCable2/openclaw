import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { retainCommandProcessCleanup } from "../process/exec-spawn.js";
import type { BufferedCommandResult } from "../process/exec.js";
import { createAudioInspector, MAX_AUDIO_INSPECTION_SOURCE_BYTES } from "./audio-inspection.js";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "./ffmpeg-limits.js";
import type { MediaFileProcessDependencies } from "./file-processing.js";

const movie = Buffer.from("000000186674797069736f6d0000020069736f6d", "hex");
const metadata = {
  format: { duration: "12" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264" },
    {
      index: 1,
      codec_type: "audio",
      codec_name: "aac",
      channels: 2,
      sample_rate: "48000",
      duration: "12",
    },
    {
      index: 3,
      codec_type: "audio",
      codec_name: "pcm_s16le",
      channels: 1,
      sample_rate: "16000",
      duration: "8",
    },
  ],
};
const statistics = [
  "[Parsed_astats_1 @ 0x01] Overall",
  "[Parsed_astats_1 @ 0x01] Peak level dB: -3",
  "[Parsed_astats_1 @ 0x01] RMS level dB: -20",
  "[Parsed_astats_1 @ 0x01] Number of samples: 48000",
  "[Parsed_ebur128_2 @ 0x02] Summary:",
  "  Integrated loudness:",
  "    I: -18 LUFS",
  "  Loudness range:",
  "    LRA: 2 LU",
  "  True peak:",
  "    Peak: -2.8 dBFS",
].join("\n");

function wavFixture() {
  const wav = Buffer.alloc(48);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(40, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(4, 40);
  return wav;
}
const wav = wavFixture();

function exited(stdout: Buffer, stderr = Buffer.alloc(0)): BufferedCommandResult {
  return { stdout, stderr, code: 0, signal: null, killed: false, termination: "exit" };
}

function inputPath(argv: readonly string[]) {
  const index = argv.indexOf("-i");
  const input = argv[index + 1];
  if (index < 0 || !input) {
    throw new Error("Expected one private seekable input");
  }
  return input;
}

function fixture(probeMetadata: unknown = metadata) {
  const runCommand = vi.fn<MediaFileProcessDependencies["runCommand"]>(async (argv) => {
    if (argv[0] === "ffprobe") {
      return exited(Buffer.from(JSON.stringify(probeMetadata)));
    }
    return argv.includes("null") ? exited(Buffer.alloc(0), Buffer.from(statistics)) : exited(wav);
  });
  const inspector = createAudioInspector({
    runCommand,
    resolveFfmpeg: () => "ffmpeg",
    resolveFfprobe: () => "ffprobe",
  });
  return { ...inspector, runCommand };
}

async function expectWorkspaceRemoved(input: string) {
  await expect(fs.access(path.dirname(input))).rejects.toMatchObject({ code: "ENOENT" });
}

describe("bounded native audio inspection", () => {
  it("probes all audio tracks and video presence in a private single-file workspace, then cleans it", async () => {
    const test = fixture();
    let input = "";
    test.runCommand.mockImplementationOnce(async (argv, settings) => {
      input = inputPath(argv);
      expect(await fs.readFile(input)).toEqual(movie);
      if (process.platform !== "win32") {
        expect((await fs.stat(input)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.dirname(input))).mode & 0o777).toBe(0o700);
      }
      expect(argv).toEqual(
        expect.arrayContaining([
          "-protocol_whitelist",
          "file,pipe",
          "-format_whitelist",
          "mov",
          "-f",
          "mov",
          "-enable_drefs",
          "0",
          "-use_absolute_path",
          "0",
        ]),
      );
      expect(settings).toMatchObject({
        maxOutputBytes: { stdout: 64 * 1024, stderr: 16 * 1024 },
        maxCombinedOutputBytes: 80 * 1024,
        killProcessTree: true,
      });
      return exited(Buffer.from(JSON.stringify(metadata)));
    });
    await expect(test.probeAudioBuffer({ buffer: movie })).resolves.toEqual({
      container: "mov",
      durationSeconds: 12,
      hasVideo: true,
      audioStreams: [
        { index: 1, codec: "aac", channels: 2, sampleRateHz: 48_000, durationSeconds: 12 },
        { index: 3, codec: "pcm_s16le", channels: 1, sampleRateHz: 16_000, durationSeconds: 8 },
      ],
    });
    await expectWorkspaceRemoved(input);
    expect(movie.toString("hex")).toBe("000000186674797069736f6d0000020069736f6d");
  });

  it("reports a video without audio truthfully and refuses analysis or transcription", async () => {
    const test = fixture({
      format: { duration: "12" },
      streams: [{ index: 0, codec_type: "video" }],
    });
    await expect(test.probeAudioBuffer({ buffer: movie })).resolves.toMatchObject({
      hasVideo: true,
      audioStreams: [],
    });
    await expect(test.analyzeAudioBuffer({ buffer: movie })).rejects.toThrow(
      "No matching audio stream",
    );
    const transcribe = vi.fn(async () => "unused");
    await expect(test.withExtractedAudioFile({ buffer: movie }, transcribe)).rejects.toThrow(
      "No matching audio stream",
    );
    expect(transcribe).not.toHaveBeenCalled();
    expect(test.runCommand.mock.calls.every(([argv]) => argv[0] === "ffprobe")).toBe(true);
  });

  it("measures the original decoded signal without normalization, gain, downmixing, or resampling", async () => {
    const test = fixture();
    const result = await test.analyzeAudioBuffer({
      buffer: movie,
      startSeconds: 2,
      endSeconds: 5,
      silenceThresholdDbfs: -55,
      silenceDurationSeconds: 0.5,
    });
    expect(result).toMatchObject({
      measurement: "original-decoded-signal",
      startSeconds: 2,
      endSeconds: 5,
      stream: { index: 1, channels: 2, sampleRateHz: 48_000 },
      rmsDbfs: -20,
      integratedLufs: -18,
      snr: { available: false },
      silence: {
        thresholdDbfs: -55,
        minimumDurationSeconds: 0.5,
        meaning: "below-amplitude-threshold-not-speech-detection",
      },
    });
    const argv = test.runCommand.mock.calls[1]?.[0] ?? [];
    expect(argv).toEqual(
      expect.arrayContaining(["-ss", "2", "-t", "3", "-map", "0:1", "-f", "null"]),
    );
    const filters = argv[argv.indexOf("-af") + 1];
    expect(filters).toBe(
      "silencedetect=noise=-55dB:d=0.5,astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level+RMS_level+Number_of_samples,ebur128=peak=sample+true:framelog=verbose",
    );
    expect(argv).not.toContain("-ar");
    expect(argv).not.toContain("-ac");
    expect(filters).not.toMatch(/volume|loudnorm|dynaudnorm|compand|aresample|agate/);
    expect(test.runCommand.mock.calls[1]?.[1]).toMatchObject({
      maxOutputBytes: { stdout: 1024, stderr: 512 * 1024 },
      killProcessTree: true,
    });
  });

  it("selects the actual sparse stream index and its shorter default end", async () => {
    const test = fixture();
    const result = await test.analyzeAudioBuffer({ buffer: movie, streamIndex: 3 });
    expect(result).toMatchObject({
      stream: { index: 3, channels: 1, sampleRateHz: 16_000 },
      startSeconds: 0,
      endSeconds: 8,
      measuredDurationSeconds: 3,
    });
    expect(test.runCommand.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(["-map", "0:3", "-t", "8"]),
    );
    await expect(test.analyzeAudioBuffer({ buffer: movie, streamIndex: 2 })).rejects.toThrow(
      "No matching audio stream",
    );
  });

  it("uses a finite stream duration when container duration is unavailable", async () => {
    const test = fixture({
      streams: [
        { index: 0, codec_type: "audio", channels: 1, sample_rate: "16000", duration: "4" },
      ],
    });
    await expect(test.probeAudioBuffer({ buffer: wav })).resolves.toMatchObject({
      durationSeconds: 4,
      hasVideo: false,
      container: "wav",
      audioStreams: [{ codec: "unknown", sampleRateHz: 16_000 }],
    });
  });

  it.each([
    { startSeconds: -1 },
    { startSeconds: Number.NaN },
    { endSeconds: Number.POSITIVE_INFINITY },
    { startSeconds: 5, endSeconds: 5 },
    { startSeconds: 5, endSeconds: 4 },
    { endSeconds: 13 },
  ])("rejects invalid interval %j before decoding", async (selection) => {
    const test = fixture();
    await expect(test.analyzeAudioBuffer({ buffer: movie, ...selection })).rejects.toThrow(
      "finite time range",
    );
    expect(test.runCommand).toHaveBeenCalledOnce();
  });

  it("rejects an overlong selected range even within the metadata inspection duration", async () => {
    const duration = MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS + 1;
    const test = fixture({
      format: { duration },
      streams: [{ index: 0, codec_type: "audio", channels: 1, sample_rate: "16000" }],
    });
    await expect(test.analyzeAudioBuffer({ buffer: movie })).rejects.toThrow("finite time range");
    expect(test.runCommand).toHaveBeenCalledOnce();
  });

  it.each([
    { silenceThresholdDbfs: -101 },
    { silenceThresholdDbfs: -9 },
    { silenceDurationSeconds: 0 },
    { silenceDurationSeconds: 11 },
  ])("rejects unsafe silence filter settings %j", async (settings) => {
    const test = fixture();
    await expect(test.analyzeAudioBuffer({ buffer: movie, ...settings })).rejects.toThrow(
      "Silence detection requires",
    );
    expect(test.runCommand).toHaveBeenCalledOnce();
  });

  it("owns a bounded 16-kHz mono WAV for the callback only and removes both input and output afterward", async () => {
    const test = fixture();
    let output = "";
    const callback = vi.fn(
      async (audio: Parameters<Parameters<typeof test.withExtractedAudioFile>[1]>[0]) => {
        output = audio.path;
        expect(audio).toMatchObject({
          mime: "audio/wav",
          startSeconds: 1,
          endSeconds: 2,
          stream: { index: 3 },
        });
        expect(await fs.readFile(audio.path)).toEqual(wav);
        expect(audio.signal.aborted).toBe(false);
        return "transcribed";
      },
    );
    await expect(
      test.withExtractedAudioFile(
        { buffer: movie, streamIndex: 3, startSeconds: 1, endSeconds: 2, maxOutputBytes: 40_000 },
        callback,
      ),
    ).resolves.toBe("transcribed");
    const argv = test.runCommand.mock.calls[1]?.[0] ?? [];
    expect(argv).toEqual(
      expect.arrayContaining([
        "-map",
        "0:3",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "pipe:1",
      ]),
    );
    expect(argv).not.toContain("-af");
    expect(test.runCommand.mock.calls[1]?.[1]).toMatchObject({
      maxOutputBytes: { stdout: 40_000 },
    });
    await expectWorkspaceRemoved(output);
    await expectWorkspaceRemoved(inputPath(argv));
  });

  it("cleans the extracted WAV when the callback rejects", async () => {
    const test = fixture();
    let output = "";
    await expect(
      test.withExtractedAudioFile({ buffer: movie, endSeconds: 1 }, async (audio) => {
        output = audio.path;
        expect(await fs.readFile(output)).toEqual(wav);
        throw new Error("synthetic callback rejection");
      }),
    ).rejects.toThrow("synthetic callback rejection");
    await expectWorkspaceRemoved(output);
  });

  it("rejects a cancelled callback result and cleans the extracted WAV", async () => {
    const test = fixture();
    const controller = new AbortController();
    let output = "";
    await expect(
      test.withExtractedAudioFile(
        { buffer: movie, endSeconds: 1, signal: controller.signal },
        async (audio) => {
          output = audio.path;
          controller.abort(new Error("synthetic callback cancellation"));
          expect(audio.signal.aborted).toBe(true);
          return "must not publish";
        },
      ),
    ).rejects.toThrow("synthetic callback cancellation");
    await expectWorkspaceRemoved(output);
  });

  it("rejects an extraction range exceeding its byte budget before decoder admission", async () => {
    const test = fixture();
    const callback = vi.fn(async () => "unused");
    await expect(
      test.withExtractedAudioFile(
        { buffer: movie, endSeconds: 1, maxOutputBytes: 32_000 },
        callback,
      ),
    ).rejects.toThrow("transcription byte budget");
    expect(callback).not.toHaveBeenCalled();
    expect(test.runCommand).toHaveBeenCalledOnce();
  });

  it("rejects malformed decoded output before invoking transcription", async () => {
    const test = fixture();
    test.runCommand.mockResolvedValueOnce(exited(Buffer.from(JSON.stringify(metadata))));
    test.runCommand.mockResolvedValueOnce(exited(Buffer.alloc(44)));
    const callback = vi.fn(async () => "unused");
    await expect(
      test.withExtractedAudioFile({ buffer: movie, endSeconds: 1 }, callback),
    ).rejects.toThrow("no usable WAV");
    expect(callback).not.toHaveBeenCalled();
    await expectWorkspaceRemoved(inputPath(test.runCommand.mock.calls[0]?.[0] ?? []));
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from("#EXTM3U\nhttps://example.invalid/audio"),
    Buffer.from("[playlist]\nFile1=https://example.invalid/audio"),
    Buffer.from("https://example.invalid/audio.wav"),
  ])("rejects unsupported or playlist input before any process admission", async (buffer) => {
    const test = fixture();
    await expect(test.probeAudioBuffer({ buffer })).rejects.toThrow();
    expect(test.runCommand).not.toHaveBeenCalled();
  });

  it("rejects the native input-byte cap before writing or process admission", async () => {
    const test = fixture();
    // Allocate no initialized payload: the owner must reject length before reading any source bytes.
    const oversized = Buffer.allocUnsafe(MAX_AUDIO_INSPECTION_SOURCE_BYTES + 1);
    await expect(test.probeAudioBuffer({ buffer: oversized })).rejects.toThrow(
      "input must contain",
    );
    expect(test.runCommand).not.toHaveBeenCalled();
  });

  it.each([
    { streams: [], format: {} },
    { streams: [], format: { duration: 86_401 } },
    { streams: Array.from({ length: 65 }, () => ({})), format: { duration: 1 } },
    {
      streams: [{ index: 0, codec_type: "audio", channels: 9, sample_rate: "48000" }],
      format: { duration: 1 },
    },
    {
      streams: [{ index: 0, codec_type: "audio", channels: 1, sample_rate: "384001" }],
      format: { duration: 1 },
    },
    {
      streams: [{ index: -1, codec_type: "audio", channels: 1, sample_rate: "16000" }],
      format: { duration: 1 },
    },
    {
      streams: [
        { index: 1, codec_type: "audio", channels: 1, sample_rate: "16000" },
        { index: 1, codec_type: "audio", channels: 1, sample_rate: "16000" },
      ],
      format: { duration: 1 },
    },
  ])("refuses invalid or excessive metadata", async (invalid) => {
    const test = fixture(invalid);
    await expect(test.probeAudioBuffer({ buffer: movie })).rejects.toThrow();
    await expectWorkspaceRemoved(inputPath(test.runCommand.mock.calls[0]?.[0] ?? []));
  });

  it("does not expose child diagnostics and cleans the source after process failure", async () => {
    const test = fixture();
    test.runCommand.mockResolvedValueOnce({
      ...exited(Buffer.alloc(0)),
      code: 1,
      stderr: Buffer.from("/fixture/private-input.wav and untrusted tags"),
    });
    const failed = test.probeAudioBuffer({ buffer: movie });
    await expect(failed).rejects.toThrow("Audio processing failed (exit)");
    await expect(failed).rejects.not.toThrow("private-input");
    await expectWorkspaceRemoved(inputPath(test.runCommand.mock.calls[0]?.[0] ?? []));
  });

  it("honors bounded process output and rejects over-budget results", async () => {
    const test = fixture();
    test.runCommand.mockResolvedValueOnce({
      ...exited(Buffer.alloc(0)),
      code: null,
      termination: "output-limit",
    });
    await expect(test.probeAudioBuffer({ buffer: movie })).rejects.toThrow(
      "Audio processing failed (output-limit)",
    );
    test.runCommand.mockResolvedValueOnce(exited(Buffer.alloc(64 * 1024 + 1)));
    await expect(test.probeAudioBuffer({ buffer: movie })).rejects.toThrow(
      "output exceeded its byte limit",
    );
  });

  it("rejects invalid metadata JSON and oversized analysis diagnostics before publishing measurements", async () => {
    const test = fixture();
    test.runCommand.mockResolvedValueOnce(exited(Buffer.from("not JSON")));
    await expect(test.probeAudioBuffer({ buffer: movie })).rejects.toThrow("not valid JSON");
    test.runCommand.mockResolvedValueOnce(exited(Buffer.from(JSON.stringify(metadata))));
    test.runCommand.mockResolvedValueOnce(exited(Buffer.alloc(0), Buffer.alloc(512 * 1024 + 1)));
    await expect(test.analyzeAudioBuffer({ buffer: movie })).rejects.toThrow(
      "output exceeded its byte limit",
    );
  });

  it("honors cancellation before admission and after an in-flight probe, cleaning its source", async () => {
    const test = fixture();
    const before = new AbortController();
    before.abort(new Error("cancelled before admission"));
    await expect(test.probeAudioBuffer({ buffer: movie, signal: before.signal })).rejects.toThrow(
      "cancelled before admission",
    );
    expect(test.runCommand).not.toHaveBeenCalled();
    const during = new AbortController();
    test.runCommand.mockImplementationOnce(async () => {
      during.abort(new Error("cancelled during probe"));
      return exited(Buffer.from(JSON.stringify(metadata)));
    });
    await expect(test.analyzeAudioBuffer({ buffer: movie, signal: during.signal })).rejects.toThrow(
      "cancelled during probe",
    );
    expect(test.runCommand).toHaveBeenCalledOnce();
    await expectWorkspaceRemoved(inputPath(test.runCommand.mock.calls[0]?.[0] ?? []));
  });

  it("joins delayed command cleanup and preserves its failure after a bounded cancellation result", async () => {
    const test = fixture();
    const entered = createDeferred();
    const cleanup = createDeferred();
    const controller = new AbortController();
    let input = "";
    test.runCommand.mockImplementationOnce(async (argv) => {
      input = inputPath(argv);
      retainCommandProcessCleanup(cleanup.promise);
      controller.abort(new Error("cancelled before broker admission"));
      entered.resolve();
      return { ...exited(Buffer.alloc(0)), termination: "signal", code: null };
    });
    const completed = vi.fn();
    const operation = test
      .probeAudioBuffer({ buffer: movie, signal: controller.signal })
      .finally(completed);
    const rejected = expect(operation).rejects.toMatchObject({
      code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
    });
    try {
      await entered.promise;
      await expect(fs.access(input)).resolves.toBeUndefined();
      expect(completed).not.toHaveBeenCalled();
      // Without the inner scope this cleanup is ignored and only caller cancellation escapes.
      cleanup.reject(new Error("synthetic physical cleanup failed"));
      await rejected;
      await expectWorkspaceRemoved(input);
    } finally {
      cleanup.resolve();
      await operation.catch(() => undefined);
    }
  });
});
