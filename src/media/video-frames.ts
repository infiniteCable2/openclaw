import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readImageProbeFromHeader } from "rastermill";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { runCommandBuffered } from "../process/exec.js";
import { MAX_IMAGE_INPUT_PIXELS } from "./image-processor-config.js";

export const MAX_VIDEO_FRAME_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_FRAME_COUNT = 12;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_RESULT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 180_000;
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

function requireInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function detectContainer(buffer: Buffer): VideoContainer {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.byteLength === 0 ||
    buffer.byteLength > MAX_VIDEO_FRAME_SOURCE_BYTES
  ) {
    throw new Error(`Video input must contain 1..${MAX_VIDEO_FRAME_SOURCE_BYTES} bytes`);
  }
  const atom = buffer.toString("ascii", 4, 8);
  if (["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(atom)) {
    return "mov";
  }
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) {
    return "matroska";
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "AVI ") {
    return "avi";
  }
  throw new Error("Unsupported video container; use MP4/MOV, Matroska/WebM, or AVI");
}

function inputArgs(inputPath: string, container: VideoContainer): string[] {
  return [
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    container,
    "-f",
    container,
    "-max_pixels",
    String(MAX_IMAGE_INPUT_PIXELS),
    // Force a single-file demuxer. MOV external data references are never followed,
    // even when a malicious uploaded container names a local file or URL.
    ...(container === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
    "-i",
    inputPath,
  ];
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function parseMetadata(buffer: Buffer, container: VideoContainer): VideoFrameMetadata {
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
    maxSide: requireInteger(
      params.maxSide ?? (profile === "detail" ? 1920 : 960),
      "Frame maxSide",
      64,
      8192,
    ),
    targetBytes: requireInteger(
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
  requireInteger(count, "Frame count", 1, MAX_VIDEO_FRAME_COUNT);
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

  async function withSource<T>(
    params: VideoBufferParams,
    run: (source: {
      inputPath: string;
      container: VideoContainer;
      signal: AbortSignal;
      remainingMs: () => number;
    }) => Promise<T>,
  ): Promise<T> {
    params.signal?.throwIfAborted();
    const container = detectContainer(params.buffer);
    const timeoutMs = requireInteger(
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Video timeoutMs",
      1,
      MAX_TIMEOUT_MS,
    );
    const signal = AbortSignal.any([
      ...(params.signal ? [params.signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);
    const deadline = Date.now() + timeoutMs;
    const remainingMs = () => {
      signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("Video extraction timed out");
      }
      return remaining;
    };
    // A seekable private copy supports MP4 files whose metadata follows the media.
    // The caller retains its original; this workspace owns no durable media state.
    return await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "video-frames-" },
      async (workspace) => {
        const inputPath = await workspace.write("input.video", params.buffer);
        remainingMs();
        const result = await run({ inputPath, container, signal, remainingMs });
        remainingMs();
        return result;
      },
    );
  }

  async function execute(
    source: { signal: AbortSignal; remainingMs: () => number },
    binary: string,
    args: string[],
    maxBytes: number,
  ): Promise<Buffer> {
    const result = await deps.runCommand([binary, ...args], {
      signal: source.signal,
      timeoutMs: source.remainingMs(),
      maxOutputBytes: { stdout: maxBytes, stderr: 16 * 1024 },
      maxCombinedOutputBytes: maxBytes + 16 * 1024,
      killProcessTree: true,
    });
    source.remainingMs();
    if (result.termination !== "exit" || result.code !== 0) {
      // Never expose FFmpeg diagnostics containing private paths or embedded metadata.
      throw new Error(`Video processing failed (${result.termination})`);
    }
    if (result.stdout.byteLength > maxBytes) {
      throw new Error("Video output exceeded its byte limit");
    }
    return result.stdout;
  }

  async function probe(source: {
    inputPath: string;
    container: VideoContainer;
    signal: AbortSignal;
    remainingMs: () => number;
  }): Promise<VideoFrameMetadata> {
    const output = await execute(
      source,
      await deps.resolveFfprobe(),
      [
        "-v",
        "error",
        ...inputArgs(source.inputPath, source.container),
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
      requireInteger(params.timestampsSeconds.length, "Frame count", 1, MAX_VIDEO_FRAME_COUNT);
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
              ...inputArgs(source.inputPath, source.container),
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
