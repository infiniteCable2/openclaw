import path from "node:path";
import { extensionForMime } from "@openclaw/media-core/mime";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import { withTempWorkspace } from "../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runFfmpeg } from "./ffmpeg-exec.js";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "./ffmpeg-limits.js";

const WAVEFORM_BUCKETS = 200;
const PCM_SAMPLE_RATE_HZ = 8_000;

function resolveSafeAudioExtension(params: {
  inputFileName?: string;
  inputContentType?: string;
}): string {
  const fromName = path.extname(params.inputFileName ?? "").toLowerCase();
  if (/^\.[a-z0-9]{1,12}$/.test(fromName)) {
    return fromName;
  }
  const fromMime = extensionForMime(params.inputContentType ?? "")?.toLowerCase();
  return fromMime && /^\.[a-z0-9]{1,12}$/.test(fromMime) ? fromMime : ".audio";
}

/** Convert signed 16-bit little-endian mono PCM into Matrix's 0..1024 waveform scale. */
function computePcm16LeWaveform(pcm: Buffer): number[] {
  const sampleCount = Math.floor(pcm.byteLength / 2);
  if (sampleCount === 0) {
    return [];
  }
  const bucketCount = Math.min(WAVEFORM_BUCKETS, sampleCount);
  const waveform: number[] = [];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor((bucket * sampleCount) / bucketCount);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * sampleCount) / bucketCount));
    let peak = 0;
    for (let sample = start; sample < end && sample < sampleCount; sample += 1) {
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(sample * 2)));
    }
    waveform.push(Math.min(1024, Math.round((peak * 1024) / 32768)));
  }
  return waveform;
}

/** Decode bounded audio to PCM and return display-only Matrix voice waveform metadata. */
export async function getAudioWaveform(params: {
  audioBuffer: Buffer;
  inputFileName?: string;
  inputContentType?: string;
}): Promise<number[]> {
  return await withTempWorkspace(
    {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "audio-waveform-",
    },
    async (workspace) => {
      const inputPath = await workspace.write(
        `input${resolveSafeAudioExtension(params)}`,
        params.audioBuffer,
      );
      await writeExternalFileWithinRoot({
        rootDir: workspace.dir,
        path: "waveform.pcm",
        write: async (outputPath) => {
          await runFfmpeg([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            inputPath,
            "-vn",
            "-sn",
            "-dn",
            "-t",
            String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            String(PCM_SAMPLE_RATE_HZ),
            outputPath,
          ]);
        },
      });
      return computePcm16LeWaveform(await workspace.read("waveform.pcm"));
    },
  );
}
