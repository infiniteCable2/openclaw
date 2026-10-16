import { describe, expect, it } from "vitest";
import { parseAudioMeasurements } from "./audio-measurements.js";

function finalMeasurements(
  options: {
    peak?: string;
    rms?: string;
    samples?: string;
    integrated?: string;
    range?: string;
    truePeak?: string;
  } = {},
) {
  return [
    "[Parsed_astats_1 @ 0x01] Overall",
    `[Parsed_astats_1 @ 0x01] Peak level dB: ${options.peak ?? "-3.125"}`,
    `[Parsed_astats_1 @ 0x01] RMS level dB: ${options.rms ?? "-18.500"}`,
    `[Parsed_astats_1 @ 0x01] Number of samples: ${options.samples ?? "192000"}`,
    "[Parsed_ebur128_2 @ 0x02] Summary:",
    "  Integrated loudness:",
    `    I: ${options.integrated ?? "-16.2"} LUFS`,
    "    Threshold: -26.8 LUFS",
    "  Loudness range:",
    `    LRA: ${options.range ?? "4.3"} LU`,
    "    Threshold: -36.2 LUFS",
    "  True peak:",
    `    Peak: ${options.truePeak ?? "-2.9"} dBFS`,
  ].join("\n");
}

describe("final FFmpeg audio measurements", () => {
  it("uses final Overall and loudness summaries, not channel, interim, or metadata values", () => {
    const text = [
      "Input metadata: title=/fixture/private-name.wav",
      finalMeasurements({ peak: "0", rms: "-1", samples: "1", integrated: "-1" }),
      "[Parsed_astats_1 @ 0x01] Channel: 1",
      "[Parsed_astats_1 @ 0x01] Peak level dB: -0.1",
      "[Parsed_astats_1 @ 0x01] Number of samples: 999999",
      finalMeasurements(),
    ].join("\n");
    const result = parseAudioMeasurements(text, 48_000, -50, 0.3);
    expect(result).toMatchObject({
      samplePeakDbfs: -3.125,
      rmsDbfs: -18.5,
      truePeakDbtp: -2.9,
      integratedLufs: -16.2,
      loudnessRangeLu: 4.3,
      sampleCount: 192_000,
      measuredDurationSeconds: 4,
      fullScaleSampleDetected: false,
      snr: { available: false, reason: "no-separated-speech-and-noise-reference" },
    });
    expect(JSON.stringify(result)).not.toContain("private-name");
    expect(JSON.stringify(result)).not.toContain("Parsed_astats");
  });

  it("represents fully silent measurements as null rather than finite loudness or invented SNR", () => {
    const text = [
      "[silencedetect @ 0x03] silence_start: 0",
      finalMeasurements({
        peak: "-inf",
        rms: "-inf",
        truePeak: "-inf",
        integrated: "-70.0",
        range: "0.0",
      }),
    ].join("\n");
    const result = parseAudioMeasurements(text, 48_000, -55, 0.5);
    expect(result).toMatchObject({
      samplePeakDbfs: null,
      rmsDbfs: null,
      truePeakDbtp: null,
      integratedLufs: null,
      loudnessRangeLu: null,
      fullScaleSampleDetected: false,
      silence: {
        thresholdDbfs: -55,
        minimumDurationSeconds: 0.5,
        totalSeconds: 4,
        intervals: [{ startSeconds: 0, endSeconds: 4 }],
        meaning: "below-amplitude-threshold-not-speech-detection",
      },
      snr: { available: false, reason: "no-separated-speech-and-noise-reference" },
    });
  });

  it("withholds EBU loudness on clips shorter than its measurement window", () => {
    const result = parseAudioMeasurements(
      finalMeasurements({ samples: "16000" }),
      48_000,
      -50,
      0.3,
    );
    expect(result.rmsDbfs).toBe(-18.5);
    expect(result.measuredDurationSeconds).toBeCloseTo(1 / 3);
    expect(result.integratedLufs).toBeNull();
    expect(result.loudnessRangeLu).toBeNull();
  });

  it.each([
    ["0", true],
    ["-0.001", true],
    ["-0.002", false],
    ["0.5", true],
    ["-inf", false],
  ] as const)(
    "reports peak %s as possible full-scale contact=%s, never a clipping count",
    (peak, expected) => {
      const result = parseAudioMeasurements(finalMeasurements({ peak }), 48_000, -50, 0.3);
      expect(result.fullScaleSampleDetected).toBe(expected);
      expect(result).not.toHaveProperty("clippedSampleCount");
    },
  );

  it("withholds initial zero LRA before the three-second window without hiding valid integrated loudness", () => {
    const result = parseAudioMeasurements(
      finalMeasurements({ samples: "48000", range: "0.0" }),
      48_000,
      -50,
      0.3,
    );
    expect(result.integratedLufs).toBe(-16.2);
    expect(result.loudnessRangeLu).toBeNull();
  });

  it("bounds silence intervals to decoded duration, closes a trailing interval, and accepts scientific notation", () => {
    const text = [
      "[silencedetect @ 0x03] silence_end: 0.1 | silence_duration: 0.1",
      "[silencedetect @ 0x03] silence_start: -2",
      "[silencedetect @ 0x03] silence_end: 0.5 | silence_duration: 2.5",
      "[silencedetect @ 0x03] silence_start: 1e0",
      "[silencedetect @ 0x03] silence_start: 1.1",
      "[silencedetect @ 0x03] silence_end: 2e0 | silence_duration: 1",
      "[silencedetect @ 0x03] silence_start: 3.5",
      "[silencedetect @ 0x03] silence_end: 99 | silence_duration: 95.5",
      finalMeasurements(),
    ].join("\n");
    const result = parseAudioMeasurements(text, 48_000, -50, 0.3);
    expect(result.silence.intervals).toEqual([
      { startSeconds: 0, endSeconds: 0.5 },
      { startSeconds: 1, endSeconds: 2 },
      { startSeconds: 3.5, endSeconds: 4 },
    ]);
    expect(result.silence.totalSeconds).toBe(2);
    expect(result.silence.intervalsTruncated).toBe(false);
  });

  it("caps displayed silence intervals while retaining the full measured total", () => {
    const intervals = Array.from({ length: 80 }, (_, index) => [
      `[silencedetect @ 0x03] silence_start: ${index * 0.04}`,
      `[silencedetect @ 0x03] silence_end: ${index * 0.04 + 0.02}`,
    ]).flat();
    const result = parseAudioMeasurements(
      [...intervals, finalMeasurements()].join("\n"),
      48_000,
      -50,
      0.1,
    );
    expect(result.silence.intervals).toHaveLength(64);
    expect(result.silence.intervalsTruncated).toBe(true);
    expect(result.silence.totalSeconds).toBeCloseTo(1.6);
  });

  it("reads silence messages following FFmpeg carriage-return progress updates", () => {
    const text = [
      "size=0kB time=00:00:00.00 speed=0x\r[silencedetect @ 0x03] silence_start: 2",
      "size=N/A time=00:00:03.90 speed=57x\r\n",
      "[silencedetect @ 0x03] silence_end: 4 | silence_duration: 2",
      finalMeasurements(),
    ].join("\n");
    const result = parseAudioMeasurements(text, 48_000, -50, 0.3);
    expect(result.silence.intervals).toEqual([{ startSeconds: 2, endSeconds: 4 }]);
    expect(result.silence.totalSeconds).toBe(2);
  });

  it("returns unavailable optional summaries as null without inferring speech or noise", () => {
    const text = finalMeasurements().split("[Parsed_ebur128_2")[0] ?? "";
    const result = parseAudioMeasurements(text, 48_000, -50, 0.3);
    expect(result.integratedLufs).toBeNull();
    expect(result.loudnessRangeLu).toBeNull();
    expect(result.truePeakDbtp).toBeNull();
    expect(result.silence.intervals).toEqual([]);
    expect(result.snr.available).toBe(false);
    expect(result).not.toHaveProperty("speechProbability");
  });

  it.each(["0", "-1", "1.5", "NaN", "inf", "9007199254740992"])(
    "rejects incomplete sample count %s",
    (samples) => {
      expect(() =>
        parseAudioMeasurements(finalMeasurements({ samples }), 48_000, -50, 0.3),
      ).toThrow("complete sample measurements");
    },
  );

  it("rejects channel-only or truncated filter output rather than claiming a completed analysis", () => {
    expect(() =>
      parseAudioMeasurements(
        "[Parsed_astats_1 @ 0x01] Number of samples: 192000",
        48_000,
        -50,
        0.3,
      ),
    ).toThrow("complete sample measurements");
  });
});
