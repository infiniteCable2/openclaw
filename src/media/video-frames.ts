import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readImageProbeFromHeader } from "rastermill";
import type { runCommandBuffered } from "../process/exec.js";
import {
  createMediaFileProcessor,
  requireMediaInteger,
  type MediaFileSource,
} from "./file-processing.js";
import { MAX_IMAGE_INPUT_PIXELS } from "./image-processor-config.js";

export const MAX_VIDEO_FRAME_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_FRAME_COUNT = 12;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_DURATION_SECONDS = 24 * 60 * 60;

export type VideoFrameProfile = "preview" | "detail" | "source";
type VideoContainer = "mov" | "matroska" | "avi";
export type VideoFrameMetadata = {
  container: VideoContainer;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
};
export type RenderedVideoFrame = {
  buffer: Buffer;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
};
export type ExtractedVideoFrame = RenderedVideoFrame & {
  /** Requested accurate-seek coordinate, not a claim of the decoded frame's exact PTS. */
  timestampSeconds: number;
};
export type VideoFrameRendition = {
  profile?: VideoFrameProfile;
  /** Preview/detail limits. Source returns the unscaled received image instead. */
  maxSide?: number;
  targetBytes?: number;
};
export type RenderVideoFrameBufferParams = VideoFrameRendition & {
  buffer: Buffer;
  signal?: AbortSignal;
};
type VideoBufferParams = { buffer: Buffer; signal?: AbortSignal; timeoutMs?: number };
export type ExtractVideoFramesParams = VideoBufferParams &
  VideoFrameRendition & {
    timestampsSeconds: number[];
  };
type PreviewOptions = { maxSide: number; targetBytes: number; signal?: AbortSignal };
type VideoFrameDependencies = {
  runCommand: typeof runCommandBuffered;
  resolveFfmpeg: () => string | Promise<string>;
  resolveFfprobe: () => string | Promise<string>;
  encodePreview: (buffer: Buffer, options: PreviewOptions) => Promise<Buffer>;
};

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function parseMetadata(
  buffer: Buffer,
  container: MediaFileSource["container"],
): VideoFrameMetadata {
  if (container !== "mov" && container !== "matroska" && container !== "avi") {
    throw new Error("Unsupported video container");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("Video metadata is not valid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.streams) || parsed.streams.length > 64) {
    throw new Error("Video metadata is invalid or exceeds stream limits");
  }
  const streams = parsed.streams.filter(isRecord);
  const video = streams.find(
    (stream) =>
      stream.codec_type === "video" &&
      !(isRecord(stream.disposition) && stream.disposition.attached_pic === 1),
  );
  if (!video) {
    throw new Error("The input has no supported video stream");
  }
  const width = positiveNumber(video.width);
  const height = positiveNumber(video.height);
  const durationSeconds =
    positiveNumber(isRecord(parsed.format) ? parsed.format.duration : undefined) ??
    positiveNumber(video.duration);
  if (
    !width ||
    !height ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width > MAX_IMAGE_INPUT_PIXELS / height
  ) {
    throw new Error("Video dimensions are missing or exceed image pixel limits");
  }
  if (!durationSeconds || durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error("Video duration is missing or exceeds the 24-hour extraction limit");
  }
  return {
    container,
    durationSeconds,
    width,
    height,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

async function encodePreview(buffer: Buffer, options: PreviewOptions): Promise<Buffer> {
  const { createImageProcessor } = await import("./image-ops.js");
  const sides = [options.maxSide, 1600, 1280, 960, 720, 480, 320]
    .filter((side) => side <= options.maxSide)
    .filter((side, index, all) => all.indexOf(side) === index);
  const result = await createImageProcessor().encode(buffer, {
    format: "auto",
    opaque: { format: "jpeg" },
    maxBytes: options.targetBytes,
    resize: { maxSide: options.maxSide, enlarge: false },
    search: { maxSide: sides, quality: [85, 75, 65, 55, 45] },
    transparency: "flatten",
    signal: options.signal,
  });
  return result.data;
}

function resolveRendition(params: VideoFrameRendition) {
  const profile = params.profile ?? "preview";
  if (!["preview", "detail", "source"].includes(profile)) {
    throw new Error("Unknown video frame profile");
  }
  return {
    profile,
    maxSide: requireMediaInteger(
      params.maxSide ?? (profile === "detail" ? 1920 : 960),
      "Frame maxSide",
      64,
      8192,
    ),
    targetBytes: requireMediaInteger(
      params.targetBytes ?? (profile === "detail" ? 500_000 : 150_000),
      "Frame targetBytes",
      1024,
      MAX_FRAME_BYTES,
    ),
  };
}

async function renderFrame(
  original: Buffer,
  rendition: ReturnType<typeof resolveRendition>,
  signal: AbortSignal | undefined,
  encode: VideoFrameDependencies["encodePreview"],
): Promise<RenderedVideoFrame> {
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(original) || original.length === 0 || original.length > MAX_FRAME_BYTES) {
    throw new Error("Video frame is missing or exceeds image byte limits");
  }
  const source = readImageProbeFromHeader(original);
  if (
    !source ||
    !["png", "jpeg"].includes(source.format) ||
    source.width * source.height > MAX_IMAGE_INPUT_PIXELS
  ) {
    throw new Error("Video frame is missing or exceeds image pixel limits");
  }
  const { profile, maxSide, targetBytes } = rendition;
  const buffer =
    profile === "source" ? original : await encode(original, { maxSide, targetBytes, signal });
  signal?.throwIfAborted();
  const image = readImageProbeFromHeader(buffer);
  if (
    !image ||
    !["png", "jpeg"].includes(image.format) ||
    (profile !== "source" &&
      (image.format !== "jpeg" ||
        buffer.length > targetBytes ||
        Math.max(image.width, image.height) > maxSide))
  ) {
    throw new Error("Video frame could not meet the requested image limits");
  }
  return {
    buffer,
    mimeType: image.format === "png" ? "image/png" : "image/jpeg",
    width: image.width,
    height: image.height,
  };
}

/** Shared live/file/tool rendition; source never adds another lossy compression step. */
export async function renderVideoFrameBuffer(
  params: RenderVideoFrameBufferParams,
): Promise<RenderedVideoFrame> {
  return await renderFrame(params.buffer, resolveRendition(params), params.signal, encodePreview);
}

/** Select representative midpoints without ever seeking exactly past the final frame. */
export function buildVideoOverviewTimestamps(durationSeconds: number, count = 4): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Video overview requires a positive finite duration");
  }
  requireMediaInteger(count, "Frame count", 1, MAX_VIDEO_FRAME_COUNT);
  return Array.from({ length: count }, (_, index) => (durationSeconds * (index + 0.5)) / count);
}

/** Shared extraction owner; dependencies isolate process/image work in focused tests. */
export function createVideoFrameExtractor(overrides: Partial<VideoFrameDependencies> = {}) {
  const deps: VideoFrameDependencies = {
    runCommand: async (argv, options) =>
      (await import("../process/exec.js")).runCommandBuffered(argv, options),
    resolveFfmpeg: async () => (await import("./ffmpeg-exec.js")).resolveFfmpegBin(),
    resolveFfprobe: async () => (await import("./ffmpeg-exec.js")).resolveFfprobeBin(),
    encodePreview,
    ...overrides,
  };

  const processor = createMediaFileProcessor(
    {
      label: "Video",
      prefix: "video-frames-",
      maxInputBytes: MAX_VIDEO_FRAME_SOURCE_BYTES,
      containers: ["mov", "matroska", "avi"],
    },
    deps,
  );
  const { withSource } = processor;

  async function execute(
    source: MediaFileSource,
    binary: string,
    args: string[],
    maxBytes: number,
  ): Promise<Buffer> {
    const result = await processor.execute(source, binary, args, maxBytes);
    return result.stdout;
  }

  async function probe(source: MediaFileSource): Promise<VideoFrameMetadata> {
    const output = await execute(
      source,
      await deps.resolveFfprobe(),
      [
        "-v",
        "error",
        ...source.inputArgs,
        "-show_entries",
        "format=duration:stream=codec_type,width,height,duration:stream_disposition=attached_pic",
        "-of",
        "json",
      ],
      64 * 1024,
    );
    return parseMetadata(output, source.container);
  }

  return {
    probeVideoBuffer: (params: VideoBufferParams) => withSource(params, probe),
    extractVideoFrames: async (
      params: ExtractVideoFramesParams,
    ): Promise<ExtractedVideoFrame[]> => {
      requireMediaInteger(params.timestampsSeconds.length, "Frame count", 1, MAX_VIDEO_FRAME_COUNT);
      if (params.timestampsSeconds.some((time) => !Number.isFinite(time) || time < 0)) {
        throw new Error("Frame timestamps must be finite non-negative seconds");
      }
      const rendition = resolveRendition(params);
      return await withSource(params, async (source) => {
        const metadata = await probe(source);
        if (params.timestampsSeconds.some((time) => time >= metadata.durationSeconds)) {
          throw new Error("Frame timestamp is outside the video duration");
        }
        const frames: ExtractedVideoFrame[] = [];
        let totalBytes = 0;
        for (const timestampSeconds of params.timestampsSeconds) {
          const original = await execute(
            source,
            await deps.resolveFfmpeg(),
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-nostdin",
              "-filter_threads",
              "1",
              "-threads",
              "1",
              "-ss",
              String(timestampSeconds),
              ...source.inputArgs,
              "-map",
              "0:V:0",
              "-frames:v",
              "1",
              "-an",
              "-sn",
              "-dn",
              "-threads",
              "1",
              "-c:v",
              "png",
              "-f",
              "image2pipe",
              "pipe:1",
            ],
            MAX_FRAME_BYTES,
          );
          const rendered = await renderFrame(
            original,
            rendition,
            source.signal,
            deps.encodePreview,
          );
          source.remainingMs();
          totalBytes += rendered.buffer.byteLength;
          if (totalBytes > MAX_FRAME_RESULT_BYTES) {
            throw new Error("Video frame result exceeded its total byte limit");
          }
          frames.push({ timestampSeconds, ...rendered });
        }
        return frames;
      });
    },
  };
}

const defaultExtractor = createVideoFrameExtractor();
export const probeVideoBuffer = defaultExtractor.probeVideoBuffer;
export const extractVideoFrames = defaultExtractor.extractVideoFrames;
