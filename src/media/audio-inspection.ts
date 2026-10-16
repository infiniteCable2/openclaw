import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseAudioMeasurements } from "./audio-measurements.js";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "./ffmpeg-limits.js";
import {
  createMediaFileProcessor,
  requireMediaInteger,
  type MediaFileParams,
  type MediaFileProcessDependencies,
  type MediaFileSource,
} from "./file-processing.js";

export const MAX_AUDIO_INSPECTION_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 40 * 1024 * 1024;
const OUTPUT_RATE_HZ = 16_000;
export type AudioStreamInfo = {
  index: number;
  codec: string;
  channels: number;
  sampleRateHz: number;
  durationSeconds?: number;
};
export type AudioFileInfo = {
  container: MediaFileSource["container"];
  durationSeconds: number;
  hasVideo: boolean;
  audioStreams: AudioStreamInfo[];
};
export type AudioInspectionSelection = {
  streamIndex?: number;
  startSeconds?: number;
  endSeconds?: number;
};
type AudioInspectionParams = MediaFileParams & AudioInspectionSelection;

function positive(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function parseInfo(buffer: Buffer, container: MediaFileSource["container"]): AudioFileInfo {
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("Audio metadata is not valid JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.streams) || value.streams.length > 64) {
    throw new Error("Audio metadata is invalid or exceeds stream limits");
  }
  const streams = value.streams.filter(isRecord);
  const audioStreams = streams
    .filter((stream) => stream.codec_type === "audio")
    .map((stream) => {
      const sampleRateHz = positive(stream.sample_rate);
      const channels = positive(stream.channels);
      if (
        typeof stream.index !== "number" ||
        !Number.isSafeInteger(stream.index) ||
        stream.index < 0 ||
        !sampleRateHz ||
        !Number.isSafeInteger(sampleRateHz) ||
        sampleRateHz > 384_000 ||
        !channels ||
        !Number.isSafeInteger(channels) ||
        channels > 8
      ) {
        throw new Error("Audio stream metadata is missing or exceeds channel/sample-rate limits");
      }
      return {
        index: stream.index,
        codec: typeof stream.codec_name === "string" ? stream.codec_name.slice(0, 64) : "unknown",
        channels,
        sampleRateHz,
        ...(positive(stream.duration) ? { durationSeconds: positive(stream.duration) } : {}),
      };
    });
  if (new Set(audioStreams.map((stream) => stream.index)).size !== audioStreams.length) {
    throw new Error("Duplicate audio stream indices");
  }
  const durationSeconds =
    positive(isRecord(value.format) ? value.format.duration : undefined) ??
    streams.map((stream) => positive(stream.duration)).find((duration) => duration !== undefined);
  if (!durationSeconds || durationSeconds > 24 * 60 * 60) {
    throw new Error("Audio duration is missing or exceeds the 24-hour inspection limit");
  }
  return {
    container,
    durationSeconds,
    audioStreams,
    hasVideo: streams.some((s) => s.codec_type === "video"),
  };
}

function selectRange(metadata: AudioFileInfo, params: AudioInspectionSelection) {
  const stream =
    params.streamIndex === undefined
      ? metadata.audioStreams[0]
      : metadata.audioStreams.find((s) => s.index === params.streamIndex);
  if (!stream) {
    throw new Error("No matching audio stream; use info to list the available stream indices");
  }
  const startSeconds = params.startSeconds ?? 0;
  const endSeconds =
    params.endSeconds ??
    Math.min(metadata.durationSeconds, stream.durationSeconds ?? metadata.durationSeconds);
  if (
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds <= startSeconds ||
    endSeconds > metadata.durationSeconds ||
    endSeconds - startSeconds > MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS
  ) {
    throw new Error(
      `Select a finite time range inside the file, at most ${MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS} seconds`,
    );
  }
  return { stream, startSeconds, endSeconds };
}

function decodeArgs(source: MediaFileSource, range: ReturnType<typeof selectRange>) {
  return [
    "-hide_banner",
    "-nostdin",
    "-filter_threads",
    "1",
    "-threads",
    "1",
    "-ss",
    String(range.startSeconds),
    ...source.inputArgs,
    "-t",
    String(range.endSeconds - range.startSeconds),
    "-map",
    `0:${range.stream.index}`,
    "-vn",
    "-sn",
    "-dn",
    "-threads",
    "1",
  ];
}

/** Technical analysis preserves source amplitude; only explicit STT extraction resamples/downmixes. */
export function createAudioInspector(overrides: Partial<MediaFileProcessDependencies> = {}) {
  const processor = createMediaFileProcessor(
    {
      label: "Audio",
      prefix: "audio-inspect-",
      maxInputBytes: MAX_AUDIO_INSPECTION_SOURCE_BYTES,
    },
    overrides,
  );
  async function probe(source: MediaFileSource) {
    const output = await processor.execute(
      source,
      await processor.resolveFfprobe(),
      [
        "-v",
        "error",
        ...source.inputArgs,
        "-show_entries",
        "format=duration:stream=index,codec_type,codec_name,channels,sample_rate,duration",
        "-of",
        "json",
      ],
      64 * 1024,
    );
    return parseInfo(output.stdout, source.container);
  }
  return {
    probeAudioBuffer: (params: MediaFileParams) => processor.withSource(params, probe),
    analyzeAudioBuffer: (
      params: AudioInspectionParams & {
        silenceThresholdDbfs?: number;
        silenceDurationSeconds?: number;
      },
    ) =>
      processor.withSource(params, async (source) => {
        const metadata = await probe(source);
        const range = selectRange(metadata, params);
        const threshold = params.silenceThresholdDbfs ?? -50;
        const duration = params.silenceDurationSeconds ?? 0.3;
        if (
          !Number.isFinite(threshold) ||
          threshold < -100 ||
          threshold > -10 ||
          !Number.isFinite(duration) ||
          duration < 0.1 ||
          duration > 10
        ) {
          throw new Error("Silence detection requires -100..-10 dBFS and 0.1..10 seconds");
        }
        const result = await processor.execute(
          source,
          await processor.resolveFfmpeg(),
          [
            "-loglevel",
            "info",
            ...decodeArgs(source, range),
            "-af",
            `silencedetect=noise=${threshold}dB:d=${duration},astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level+RMS_level+Number_of_samples,ebur128=peak=sample+true:framelog=verbose`,
            "-f",
            "null",
            "-",
          ],
          1024,
          512 * 1024,
        );
        return {
          ...range,
          metadata,
          measurement: "original-decoded-signal" as const,
          ...parseAudioMeasurements(
            result.stderr.toString("utf8"),
            range.stream.sampleRateHz,
            threshold,
            duration,
          ),
        };
      }),
    withExtractedAudioFile: <T>(
      params: AudioInspectionParams & { maxOutputBytes?: number },
      run: (audio: {
        path: string;
        mime: "audio/wav";
        signal: AbortSignal;
        metadata: AudioFileInfo;
        startSeconds: number;
        endSeconds: number;
        stream: AudioStreamInfo;
      }) => Promise<T>,
    ) =>
      processor.withSource(params, async (source) => {
        const metadata = await probe(source);
        const range = selectRange(metadata, params);
        const maxBytes = requireMediaInteger(
          params.maxOutputBytes ?? MAX_EXTRACTED_BYTES,
          "Extracted audio maxOutputBytes",
          4096,
          MAX_EXTRACTED_BYTES,
        );
        // Bound output before decode, allowing room for a WAV header and codec rounding.
        if ((range.endSeconds - range.startSeconds) * OUTPUT_RATE_HZ * 2 + 4096 > maxBytes) {
          throw new Error(
            "The selected range exceeds the transcription byte budget; select a shorter interval",
          );
        }
        const result = await processor.execute(
          source,
          await processor.resolveFfmpeg(),
          [
            "-loglevel",
            "error",
            ...decodeArgs(source, range),
            "-ac",
            "1",
            "-ar",
            String(OUTPUT_RATE_HZ),
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "pipe:1",
          ],
          maxBytes,
        );
        if (
          result.stdout.length < 44 ||
          result.stdout.toString("ascii", 0, 4) !== "RIFF" ||
          result.stdout.toString("ascii", 8, 12) !== "WAVE"
        ) {
          throw new Error("Audio extraction returned no usable WAV");
        }
        const path = await source.write("speech.wav", result.stdout);
        source.remainingMs();
        const value = await run({
          path,
          mime: "audio/wav",
          signal: source.signal,
          metadata,
          ...range,
        });
        source.remainingMs();
        return value;
      }),
  };
}

const inspector = createAudioInspector();
export const probeAudioBuffer = inspector.probeAudioBuffer;
export const analyzeAudioBuffer = inspector.analyzeAudioBuffer;
export const withExtractedAudioFile = inspector.withExtractedAudioFile;
