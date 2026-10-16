import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import type { BufferedCommandResult, runCommandBuffered } from "../process/exec.js";
import { MAX_IMAGE_INPUT_PIXELS } from "./image-processor-config.js";

export type MediaFileContainer =
  | "mov"
  | "matroska"
  | "avi"
  | "wav"
  | "ogg"
  | "flac"
  | "mp3"
  | "aac"
  | "aiff"
  | "amr";
export type MediaFileParams = { buffer: Buffer; signal?: AbortSignal; timeoutMs?: number };
export type MediaFileProcessDependencies = {
  runCommand: typeof runCommandBuffered;
  resolveFfmpeg: () => string | Promise<string>;
  resolveFfprobe: () => string | Promise<string>;
};
export type MediaFileSource = {
  container: MediaFileContainer;
  signal: AbortSignal;
  remainingMs(): number;
  inputArgs: string[];
  write(name: string, buffer: Buffer): Promise<string>;
};

export function requireMediaInteger(value: number, name: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function detectContainer(buffer: Buffer): MediaFileContainer {
  const head = buffer.toString("ascii", 0, 12);
  const first = buffer[0];
  const second = buffer[1];
  if (["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(head.slice(4, 8))) {
    return "mov";
  }
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) {
    return "matroska";
  }
  if (head.startsWith("RIFF") && head.slice(8, 12) === "AVI ") {
    return "avi";
  }
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WAVE") {
    return "wav";
  }
  if (head.startsWith("OggS")) {
    return "ogg";
  }
  if (head.startsWith("fLaC")) {
    return "flac";
  }
  if (head.startsWith("FORM") && ["AIFF", "AIFC"].includes(head.slice(8, 12))) {
    return "aiff";
  }
  if (head.startsWith("#!AMR\n") || head.startsWith("#!AMR-WB\n")) {
    return "amr";
  }
  if (first === 0xff && second !== undefined && (second & 0xf6) === 0xf0) {
    return "aac";
  }
  if (
    head.startsWith("ID3") ||
    (first === 0xff && second !== undefined && (second & 0xe0) === 0xe0 && (second & 0x06) !== 0)
  ) {
    return "mp3";
  }
  throw new Error("Unsupported single-file media container");
}

/** One bounded, seekable, single-file process boundary for frame and audio inspection. */
export function createMediaFileProcessor(
  options: {
    label: string;
    prefix: string;
    maxInputBytes: number;
    containers?: readonly MediaFileContainer[];
  },
  overrides: Partial<MediaFileProcessDependencies> = {},
) {
  const deps: MediaFileProcessDependencies = {
    runCommand: async (argv, settings) =>
      (await import("../process/exec.js")).runCommandBuffered(argv, settings),
    resolveFfmpeg: async () => (await import("./ffmpeg-exec.js")).resolveFfmpegBin(),
    resolveFfprobe: async () => (await import("./ffmpeg-exec.js")).resolveFfprobeBin(),
    ...overrides,
  };
  return {
    ...deps,
    async execute(
      source: MediaFileSource,
      binary: string,
      args: string[],
      maxBytes: number,
      stderrBytes = 16 * 1024,
    ): Promise<BufferedCommandResult> {
      const result = await deps.runCommand([binary, ...args], {
        signal: source.signal,
        timeoutMs: source.remainingMs(),
        maxOutputBytes: { stdout: maxBytes, stderr: stderrBytes },
        maxCombinedOutputBytes: maxBytes + stderrBytes,
        killProcessTree: true,
      });
      source.remainingMs();
      if (result.termination !== "exit" || result.code !== 0) {
        // Child diagnostics may contain private paths and untrusted container metadata.
        throw new Error(`${options.label} processing failed (${result.termination})`);
      }
      if (result.stdout.byteLength > maxBytes || result.stderr.byteLength > stderrBytes) {
        throw new Error(`${options.label} output exceeded its byte limit`);
      }
      return result;
    },
    async withSource<T>(
      params: MediaFileParams,
      run: (source: MediaFileSource) => Promise<T>,
    ): Promise<T> {
      params.signal?.throwIfAborted();
      if (
        !Buffer.isBuffer(params.buffer) ||
        !params.buffer.length ||
        params.buffer.length > options.maxInputBytes
      ) {
        throw new Error(`${options.label} input must contain 1..${options.maxInputBytes} bytes`);
      }
      const container = detectContainer(params.buffer);
      if (options.containers && !options.containers.includes(container)) {
        throw new Error(`Unsupported ${options.label.toLowerCase()} container`);
      }
      const timeoutMs = requireMediaInteger(
        params.timeoutMs ?? 45_000,
        "Media timeoutMs",
        1,
        180_000,
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
          throw new Error(`${options.label} processing timed out`);
        }
        return remaining;
      };
      return withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: options.prefix },
        async (workspace) => {
          const { withCommandProcessScope } = await import("../process/exec-spawn.js");
          // Bounded process results can precede physical cleanup during broker startup.
          // Join that cleanup before the workspace owner removes any input or output.
          return withCommandProcessScope(async () => {
            const inputPath = await workspace.write("input.media", params.buffer);
            remainingMs();
            const result = await run({
              container,
              signal,
              remainingMs,
              inputArgs: [
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                container,
                "-f",
                container,
                ...(["mov", "matroska", "avi"].includes(container)
                  ? ["-max_pixels", String(MAX_IMAGE_INPUT_PIXELS)]
                  : []),
                // Never follow MOV external data references, local or remote.
                ...(container === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
                "-i",
                inputPath,
              ],
              write: (name, buffer) => workspace.write(name, buffer),
            });
            remainingMs();
            return result;
          }, signal);
        },
      );
    },
  };
}
