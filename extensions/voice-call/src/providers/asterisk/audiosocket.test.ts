import { describe, expect, it } from "vitest";
import {
  AudioSocketFrameDecoder,
  AudioSocketType,
  audioSocketSampleRateForType,
  audioSocketTypeForSampleRate,
  encodeAudioSocketFrame,
  uuidFromAudioSocketPayload,
  uuidToAudioSocketPayload,
} from "./audiosocket.js";

describe("Asterisk AudioSocket framing", () => {
  it("decodes fragmented and coalesced TCP input without losing frame boundaries", () => {
    const decoder = new AudioSocketFrameDecoder();
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const bytes = Buffer.concat([
      encodeAudioSocketFrame(AudioSocketType.uuid, uuidToAudioSocketPayload(uuid)),
      encodeAudioSocketFrame(AudioSocketType.dtmf, Buffer.from("5")),
      encodeAudioSocketFrame(AudioSocketType.pcm16k, Buffer.from([1, 2, 3, 4])),
    ]);

    expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
    expect(decoder.push(bytes.subarray(2, 11))).toEqual([]);
    const frames = decoder.push(bytes.subarray(11));

    expect(frames.map((frame) => frame.type)).toEqual([
      AudioSocketType.uuid,
      AudioSocketType.dtmf,
      AudioSocketType.pcm16k,
    ]);
    expect(uuidFromAudioSocketPayload(frames[0]!.payload)).toBe(uuid);
    expect(frames[1]!.payload.toString("ascii")).toBe("5");
    expect(frames[2]!.payload).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(decoder.bufferedBytes).toBe(0);
  });

  it.each([
    [8_000, 0x10],
    [12_000, 0x11],
    [16_000, 0x12],
    [24_000, 0x13],
    [32_000, 0x14],
    [44_100, 0x15],
    [48_000, 0x16],
    [96_000, 0x17],
    [192_000, 0x18],
  ])("maps $0 Hz PCM to its AudioSocket type", (sampleRate, type) => {
    expect(audioSocketTypeForSampleRate(sampleRate)).toBe(type);
    expect(audioSocketSampleRateForType(type)).toBe(sampleRate);
  });

  it("uses a big-endian payload length and rejects oversized payloads", () => {
    const frame = encodeAudioSocketFrame(0x10, Buffer.alloc(0x1234));
    expect(frame.subarray(0, 3)).toEqual(Buffer.from([0x10, 0x12, 0x34]));
    expect(() => encodeAudioSocketFrame(0x10, Buffer.alloc(0x10000))).toThrow(
      "payload exceeds 65535 bytes",
    );
  });

  it("rejects malformed UUIDs and UUID frames", () => {
    expect(() => uuidToAudioSocketPayload("not-a-uuid")).toThrow("canonical");
    expect(() => uuidFromAudioSocketPayload(Buffer.alloc(15))).toThrow("exactly 16 bytes");
  });
});
