import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePngRgb, encodePngRgba, encodePngRgbaAsync } from "./png-encode.js";

describe("native PNG encoding", () => {
  it("preserves RGBA bytes using asynchronous compression", async () => {
    const pixels = Buffer.from([255, 0, 30, 255, 0, 64, 0, 255]);
    const png = await encodePngRgbaAsync(pixels, 2, 1);
    expect(png).toEqual(encodePngRgba(pixels, 2, 1));
    const length = png.readUInt32BE(33);
    expect(inflateSync(png.subarray(41, 41 + length))).toEqual(
      Buffer.concat([Buffer.from([0]), pixels]),
    );
  });
  it.each([encodePngRgb, encodePngRgba])("rejects invalid or unbounded pixel layouts", (encode) => {
    expect(() => encode(Buffer.alloc(4), 100_000, 100_000)).toThrow("bounded");
    expect(() => encode(Buffer.alloc(4), -1, 1)).toThrow("bounded");
    expect(() => encode(Buffer.alloc(4), 1.5, 1)).toThrow("bounded");
  });
  it("does not publish a frame after cancellation", async () => {
    const controller = new AbortController();
    const encoding = encodePngRgbaAsync(Buffer.alloc(16), 2, 2, controller.signal);
    controller.abort();
    await expect(encoding).rejects.toThrow();
  });
});
