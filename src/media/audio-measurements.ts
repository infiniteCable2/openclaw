export type AudioMeasurements = {
  samplePeakDbfs: number | null;
  rmsDbfs: number | null;
  truePeakDbtp: number | null;
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  sampleCount: number;
  measuredDurationSeconds: number;
  fullScaleSampleDetected: boolean;
  silence: {
    thresholdDbfs: number;
    minimumDurationSeconds: number;
    totalSeconds: number;
    intervals: { startSeconds: number; endSeconds: number }[];
    intervalsTruncated: boolean;
    timeBasis: "relative-to-selected-range";
    meaning: "below-amplitude-threshold-not-speech-detection";
  };
  snr: { available: false; reason: "no-separated-speech-and-noise-reference" };
};

function finiteValue(text: string | undefined): number | null {
  if (!text?.trim()) {
    return null;
  }
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

/** Parse only final filter-owned measurements; never return paths, tags or raw child output. */
export function parseAudioMeasurements(
  text: string,
  sampleRateHz: number,
  silenceThresholdDbfs: number,
  silenceDurationSeconds: number,
): AudioMeasurements {
  const overall = text.slice(text.lastIndexOf("] Overall"));
  const stat = (name: string) => {
    const match = overall.match(
      new RegExp(`^\\[Parsed_astats_[^\\]\\r\\n]+\\] ${name}: ([^\\r\\n]+)$`, "m"),
    );
    return finiteValue(match?.[1]);
  };
  const sampleCount = stat("Number of samples");
  if (sampleCount === null || !Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
    throw new Error("Audio analysis produced no complete sample measurements");
  }
  const measuredDurationSeconds = sampleCount / sampleRateHz;
  const samplePeakDbfs = stat("Peak level dB");
  const rmsDbfs = stat("RMS level dB");
  const summary = text.slice(text.lastIndexOf("] Summary:"));
  const loudness = finiteValue(summary.match(/Integrated loudness:\s+I:\s+([^\s]+) LUFS/)?.[1]);
  const range = finiteValue(summary.match(/Loudness range:\s+LRA:\s+([^\s]+) LU/)?.[1]);
  const truePeakDbtp = finiteValue(summary.match(/True peak:\s+Peak:\s+([^\s]+) dBFS/)?.[1]);
  const intervals: AudioMeasurements["silence"]["intervals"] = [];
  let silenceStart: number | undefined;
  let totalSeconds = 0;
  let count = 0;
  const addSilence = (end: number) => {
    if (silenceStart === undefined) {
      return;
    }
    const endSeconds = Math.min(measuredDurationSeconds, Math.max(silenceStart, end));
    totalSeconds += endSeconds - silenceStart;
    count++;
    if (intervals.length < 64) {
      intervals.push({ startSeconds: silenceStart, endSeconds });
    }
    silenceStart = undefined;
  };
  // FFmpeg progress updates use bare CR and can directly precede filter messages.
  for (const line of text.split(/[\r\n]+/)) {
    const match = line.match(
      /^\[(?:Parsed_)?silencedetect(?:_\d+)? @ [^\]\r\n]+\] silence_(start|end): (-?[\d.e+-]+)/,
    );
    const value = finiteValue(match?.[2]);
    if (value === null) {
      continue;
    }
    if (match?.[1] === "start") {
      silenceStart ??= Math.min(measuredDurationSeconds, Math.max(0, value));
    } else {
      addSilence(value);
    }
  }
  addSilence(measuredDurationSeconds);
  return {
    samplePeakDbfs,
    rmsDbfs,
    truePeakDbtp,
    integratedLufs: rmsDbfs === null || measuredDurationSeconds < 0.4 ? null : loudness,
    loudnessRangeLu: rmsDbfs === null || measuredDurationSeconds < 3 ? null : range,
    sampleCount,
    measuredDurationSeconds,
    // Full-scale contact indicates possible clipping, not a count of clipped samples.
    fullScaleSampleDetected: samplePeakDbfs !== null && samplePeakDbfs >= -0.001,
    silence: {
      thresholdDbfs: silenceThresholdDbfs,
      minimumDurationSeconds: silenceDurationSeconds,
      totalSeconds,
      intervals,
      intervalsTruncated: count > intervals.length,
      timeBasis: "relative-to-selected-range",
      meaning: "below-amplitude-threshold-not-speech-detection",
    },
    snr: { available: false, reason: "no-separated-speech-and-noise-reference" },
  };
}
