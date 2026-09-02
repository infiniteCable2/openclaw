// Asterisk AudioSocket framing primitives.

export const AUDIOSOCKET_HEADER_BYTES = 3;
export const AUDIOSOCKET_MAX_PAYLOAD_BYTES = 0xffff;

export const AudioSocketType = {
  hangup: 0x00,
  uuid: 0x01,
  dtmf: 0x03,
  pcm8k: 0x10,
  pcm12k: 0x11,
  pcm16k: 0x12,
  pcm24k: 0x13,
  pcm32k: 0x14,
  pcm44k: 0x15,
  pcm48k: 0x16,
  pcm96k: 0x17,
  pcm192k: 0x18,
  error: 0xff,
} as const;

const AUDIO_TYPE_BY_SAMPLE_RATE = new Map<number, number>([
  [8_000, AudioSocketType.pcm8k],
  [12_000, AudioSocketType.pcm12k],
  [16_000, AudioSocketType.pcm16k],
  [24_000, AudioSocketType.pcm24k],
  [32_000, AudioSocketType.pcm32k],
  [44_100, AudioSocketType.pcm44k],
  [48_000, AudioSocketType.pcm48k],
  [96_000, AudioSocketType.pcm96k],
  [192_000, AudioSocketType.pcm192k],
]);

const SAMPLE_RATE_BY_AUDIO_TYPE = new Map<number, number>(
  [...AUDIO_TYPE_BY_SAMPLE_RATE].map(([sampleRate, type]) => [type, sampleRate]),
);

const UUID_PATTERN =
  /^(?<a>[0-9a-f]{8})-(?<b>[0-9a-f]{4})-(?<c>[0-9a-f]{4})-(?<d>[0-9a-f]{4})-(?<e>[0-9a-f]{12})$/iu;

export type AudioSocketFrame = {
  type: number;
  payload: Buffer;
};

export function audioSocketTypeForSampleRate(sampleRate: number): number | undefined {
  return AUDIO_TYPE_BY_SAMPLE_RATE.get(sampleRate);
}

export function audioSocketSampleRateForType(type: number): number | undefined {
  return SAMPLE_RATE_BY_AUDIO_TYPE.get(type);
}

export function encodeAudioSocketFrame(
  type: number,
  payload: Uint8Array = Buffer.alloc(0),
): Buffer {
  if (!Number.isInteger(type) || type < 0 || type > 0xff) {
    throw new Error("AudioSocket frame type must be an unsigned byte");
  }
  if (payload.byteLength > AUDIOSOCKET_MAX_PAYLOAD_BYTES) {
    throw new Error(`AudioSocket payload exceeds ${AUDIOSOCKET_MAX_PAYLOAD_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(AUDIOSOCKET_HEADER_BYTES + payload.byteLength);
  frame[0] = type;
  frame.writeUInt16BE(payload.byteLength, 1);
  Buffer.from(payload).copy(frame, AUDIOSOCKET_HEADER_BYTES);
  return frame;
}

export function uuidToAudioSocketPayload(uuid: string): Buffer {
  const match = UUID_PATTERN.exec(uuid.trim());
  if (!match?.groups) {
    throw new Error("AudioSocket UUID must use the canonical 8-4-4-4-12 form");
  }
  return Buffer.from(Object.values(match.groups).join(""), "hex");
}

export function uuidFromAudioSocketPayload(payload: Uint8Array): string {
  if (payload.byteLength !== 16) {
    throw new Error("AudioSocket UUID payload must contain exactly 16 bytes");
  }
  const hex = Buffer.from(payload).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Incremental decoder because TCP may split or coalesce AudioSocket frames. */
export class AudioSocketFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): AudioSocketFrame[] {
    if (chunk.byteLength === 0) {
      return [];
    }
    this.buffered =
      this.buffered.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const frames: AudioSocketFrame[] = [];
    let offset = 0;
    while (this.buffered.byteLength - offset >= AUDIOSOCKET_HEADER_BYTES) {
      const type = this.buffered.readUInt8(offset);
      const payloadBytes = this.buffered.readUInt16BE(offset + 1);
      const frameBytes = AUDIOSOCKET_HEADER_BYTES + payloadBytes;
      if (this.buffered.byteLength - offset < frameBytes) {
        break;
      }
      frames.push({
        type,
        payload: Buffer.from(
          this.buffered.subarray(offset + AUDIOSOCKET_HEADER_BYTES, offset + frameBytes),
        ),
      });
      offset += frameBytes;
    }
    if (offset > 0) {
      this.buffered = Buffer.from(this.buffered.subarray(offset));
    }
    return frames;
  }

  get bufferedBytes(): number {
    return this.buffered.byteLength;
  }
}
