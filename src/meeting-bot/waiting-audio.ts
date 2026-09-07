import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { convertMeetingTtsAudioForBridge } from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";

const MAX_WAITING_AUDIO_BYTES = 8 * 1024 * 1024;
const WAITING_AUDIO_FRAME_MS = 20;

export type MeetingWaitingAudioConfig = {
  filePath: string;
  startDelayMs: number;
  volume: number;
};

export type PreparedMeetingWaitingAudio = {
  pcm: Buffer;
  frameBytes: number;
  startDelayMs: number;
};

const preparedAudioCache = new Map<string, Promise<PreparedMeetingWaitingAudio>>();

function readPcm16MonoWav(input: Buffer): { pcm: Buffer; sampleRate: number } {
  if (
    input.byteLength < 12 ||
    input.toString("ascii", 0, 4) !== "RIFF" ||
    input.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("meeting waiting audio must be a RIFF/WAVE file");
  }
  let offset = 12;
  let format:
    | { audioFormat: number; channels: number; sampleRate: number; bits: number }
    | undefined;
  let pcm: Buffer | undefined;
  while (offset + 8 <= input.byteLength) {
    const chunkId = input.toString("ascii", offset, offset + 4);
    const chunkBytes = input.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkBytes;
    if (dataEnd > input.byteLength) {
      throw new Error("meeting waiting audio contains a truncated WAV chunk");
    }
    if (chunkId === "fmt " && chunkBytes >= 16) {
      format = {
        audioFormat: input.readUInt16LE(dataOffset),
        channels: input.readUInt16LE(dataOffset + 2),
        sampleRate: input.readUInt32LE(dataOffset + 4),
        bits: input.readUInt16LE(dataOffset + 14),
      };
    } else if (chunkId === "data" && !pcm) {
      pcm = Buffer.from(input.subarray(dataOffset, dataEnd));
    }
    offset = dataEnd + (chunkBytes % 2);
  }
  if (!format || format.audioFormat !== 1 || format.channels !== 1 || format.bits !== 16) {
    throw new Error("meeting waiting audio must be mono PCM16 WAV");
  }
  if (format.sampleRate < 8_000 || format.sampleRate > 48_000) {
    throw new Error("meeting waiting audio sample rate must be between 8 kHz and 48 kHz");
  }
  if (!pcm || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error("meeting waiting audio PCM payload is empty or incomplete");
  }
  return { pcm, sampleRate: format.sampleRate };
}

function scalePcm16(input: Buffer, volume: number): Buffer {
  if (volume === 1) {
    return input;
  }
  const output = Buffer.allocUnsafe(input.byteLength);
  for (let offset = 0; offset < input.byteLength; offset += 2) {
    const sample = Math.round(input.readInt16LE(offset) * volume);
    output.writeInt16LE(Math.max(-32_768, Math.min(32_767, sample)), offset);
  }
  return output;
}

export async function prepareMeetingWaitingAudio(
  config: MeetingWaitingAudioConfig | undefined,
  audioFormat: MeetingRealtimeAudioFormat,
): Promise<PreparedMeetingWaitingAudio | undefined> {
  if (!config) {
    return undefined;
  }
  const cacheKey = JSON.stringify([
    config.filePath,
    config.startDelayMs,
    config.volume,
    audioFormat,
  ]);
  let prepared = preparedAudioCache.get(cacheKey);
  if (!prepared) {
    prepared = (async () => {
      if (!path.isAbsolute(config.filePath)) {
        throw new Error("meeting waiting audio path must be absolute");
      }
      const linkInfo = await lstat(config.filePath);
      if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
        throw new Error("meeting waiting audio must be a regular file, not a symlink");
      }
      const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
      const handle = await open(config.filePath, flags);
      let sourceBytes: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile()) {
          throw new Error("meeting waiting audio must be a regular file, not a symlink");
        }
        if (process.platform !== "win32" && (info.mode & 0o022) !== 0) {
          throw new Error("meeting waiting audio must not be group- or world-writable");
        }
        if (info.size <= 0 || info.size > MAX_WAITING_AUDIO_BYTES) {
          throw new Error("meeting waiting audio file size is outside the supported range");
        }
        sourceBytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      const source = readPcm16MonoWav(sourceBytes);
      const scaled = scalePcm16(source.pcm, config.volume);
      const pcm = convertMeetingTtsAudioForBridge(scaled, source.sampleRate, audioFormat, "pcm");
      if (pcm.byteLength === 0) {
        throw new Error("meeting waiting audio conversion produced no audio");
      }
      return {
        pcm,
        frameBytes: audioFormat === "g711-ulaw-8khz" ? 160 : 960,
        startDelayMs: config.startDelayMs,
      };
    })();
    preparedAudioCache.set(cacheKey, prepared);
    void prepared.catch(() => preparedAudioCache.delete(cacheKey));
  }
  return await prepared;
}

function nextLoopingFrame(audio: Buffer, offset: number, frameBytes: number): Buffer {
  if (offset + frameBytes <= audio.byteLength) {
    return audio.subarray(offset, offset + frameBytes);
  }
  const frame = Buffer.allocUnsafe(frameBytes);
  let sourceOffset = offset;
  let written = 0;
  while (written < frameBytes) {
    const copyBytes = Math.min(audio.byteLength - sourceOffset, frameBytes - written);
    audio.copy(frame, written, sourceOffset, sourceOffset + copyBytes);
    written += copyBytes;
    sourceOffset = (sourceOffset + copyBytes) % audio.byteLength;
  }
  return frame;
}

export async function playMeetingWaitingAudio(params: {
  audio: PreparedMeetingWaitingAudio;
  transport: Pick<MeetingRealtimeAudioTransport, "writeOutput">;
  signal: AbortSignal;
  onStarted?: () => void;
}): Promise<void> {
  let offset = 0;
  let deadline = Date.now();
  let started = false;
  while (!params.signal.aborted) {
    const frame = nextLoopingFrame(params.audio.pcm, offset, params.audio.frameBytes);
    await params.transport.writeOutput(frame);
    if (!started) {
      started = true;
      params.onStarted?.();
    }
    offset = (offset + params.audio.frameBytes) % params.audio.pcm.byteLength;
    deadline += WAITING_AUDIO_FRAME_MS;
    try {
      await delay(Math.max(0, deadline - Date.now()), undefined, { signal: params.signal });
    } catch (error) {
      if (params.signal.aborted) {
        return;
      }
      throw error;
    }
  }
}
