import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ encode: vi.fn(async (data: Buffer) => Buffer.from(data)) }));
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({ encodePngRgbaAsync: mocks.encode }));
import {
  consumeMatrixRtcVideo,
  decodeMatrixRtcVideoHeader,
  resolveMatrixRtcVideoLimits,
} from "./rtc-video.js";

const options = { enabled: true };
function frameHeader(
  overrides: { bytes?: number; width?: number; height?: number; source?: number } = {},
) {
  const buffer = Buffer.alloc(32);
  buffer.write("OCVF");
  buffer[4] = 1;
  buffer[5] = 1;
  buffer.writeBigUInt64BE(1234n, 8);
  buffer.writeUInt32BE(overrides.width ?? 1, 16);
  buffer.writeUInt32BE(overrides.height ?? 1, 20);
  buffer.writeUInt32BE(overrides.source ?? 1, 24);
  buffer.writeUInt32BE(overrides.bytes ?? 4, 28);
  return buffer;
}
async function* chunks(...values: Buffer[]) {
  yield* values;
}

describe("MatrixRTC isolated video input", () => {
  it("bounds capture policy and rejects oversized records before reading pixels", () => {
    expect(resolveMatrixRtcVideoLimits(options)).toEqual({
      intervalMs: 1000,
      maxSourceDimension: 1920,
      maxSourceBytes: 16 * 1024 * 1024,
    });
    expect(() => resolveMatrixRtcVideoLimits({ enabled: true, intervalMs: 0 })).toThrow();
    expect(() =>
      decodeMatrixRtcVideoHeader(frameHeader({ width: 4096, height: 4096 }), options),
    ).toThrow();
    expect(() =>
      decodeMatrixRtcVideoHeader(frameHeader({ bytes: 64 * 1024 * 1024 }), options),
    ).toThrow();
    expect(() => decodeMatrixRtcVideoHeader(frameHeader({ source: 0 }), options)).toThrow();
  });

  it("reassembles split and coalesced records into actual image callbacks, never JSON/base64", async () => {
    const onFrame = vi.fn();
    const first = Buffer.concat([frameHeader(), Buffer.from([1, 2, 3, 255])]);
    await consumeMatrixRtcVideo({
      source: chunks(first.subarray(0, 7), Buffer.concat([first.subarray(7), first])),
      options,
      isCurrent: () => true,
      onFrame,
    });
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame).toHaveBeenLastCalledWith({
      data: Buffer.from([1, 2, 3, 255]),
      mimeType: "image/png",
      timestampMs: 1234,
      sourceId: "video-1",
    });
  });

  it("does not emit a frame after its session closes during asynchronous encoding", async () => {
    let current = true;
    const onFrame = vi.fn();
    mocks.encode.mockImplementationOnce(async (data) => {
      current = false;
      return Buffer.from(data);
    });
    await consumeMatrixRtcVideo({
      source: chunks(frameHeader(), Buffer.alloc(4)),
      options,
      isCurrent: () => current,
      onFrame,
    });
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("rejects incomplete records and unsupported binary versions", async () => {
    await expect(
      consumeMatrixRtcVideo({
        source: chunks(frameHeader(), Buffer.alloc(3)),
        options,
        isCurrent: () => true,
        onFrame: vi.fn(),
      }),
    ).rejects.toThrow("inside a frame");
    const invalid = frameHeader();
    invalid[4] = 2;
    expect(() => decodeMatrixRtcVideoHeader(invalid, options)).toThrow("header is invalid");
  });
});
