import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { createVideoFrameBuffer } from "./video-frame-buffer.js";

describe("session video source custody", () => {
  function fixture() {
    let time = 1000;
    const buffer = createVideoFrameBuffer({
      intervalMs: 100,
      retentionMs: 1000,
      maxBytes: 6,
      maxFrameBytes: 3,
      maxFramesPerTurn: 3,
      now: () => time,
    });
    const add = (value: string, timestampMs = time) =>
      buffer.add({ data: Buffer.from(value), mimeType: "image/png", timestampMs });
    return {
      buffer,
      add,
      advance: (ms: number) => {
        time += ms;
      },
    };
  }
  it("owns source bytes and samples rather than retaining every camera frame", () => {
    const { buffer, advance } = fixture();
    const input = Buffer.from("abc");
    expect(buffer.add({ data: input, mimeType: "image/png", timestampMs: 1000 })).toBe(true);
    input.fill(0);
    expect(expectDefined(buffer.capture(0).frames[0], "captured frame").data.toString()).toBe(
      "abc",
    );
    expect(buffer.add({ data: input, mimeType: "image/png", timestampMs: 1001 })).toBe(false);
    advance(100);
    expect(buffer.add({ data: input, mimeType: "image/png", timestampMs: 1100 })).toBe(true);
  });
  it("pins selected sources beyond TTL without exceeding the shared byte cap", () => {
    const { buffer, add, advance } = fixture();
    add("abc");
    advance(100);
    add("def");
    const snapshot = buffer.capture(0);
    advance(2000);
    expect(add("ghi")).toBe(false);
    expect(buffer.sizeBytes).toBe(6);
    const first = expectDefined(snapshot.frames[0], "pinned frame");
    expect(buffer.read(first.id)?.data.toString()).toBe("abc");
    snapshot.release();
    snapshot.release();
    expect(buffer.sizeBytes).toBe(0);
    expect(buffer.read(first.id)).toBeUndefined();
    expect(add("ghi")).toBe(true);
  });
  it("rejects stale/future/oversized sources and releases sources on session close", () => {
    const { buffer, add } = fixture();
    expect(add("long")).toBe(false);
    expect(add("abc", -100)).toBe(false);
    expect(add("abc", 3000)).toBe(false);
    add("abc");
    const snapshot = buffer.capture(0);
    buffer.close();
    expect(buffer.read(expectDefined(snapshot.frames[0], "closing frame").id)).toBeUndefined();
    expect(buffer.sizeBytes).toBe(0);
    expect(add("def")).toBe(false);
    snapshot.release();
  });
  it("selects the beginning, middle and end of the exact requested range", () => {
    let time = 1000;
    const buffer = createVideoFrameBuffer({
      intervalMs: 1,
      retentionMs: 2000,
      maxBytes: 100,
      maxFrameBytes: 10,
      maxFramesPerTurn: 3,
      now: () => time,
    });
    for (; time <= 2000; time += 100) {
      buffer.add({ data: Buffer.from("a"), mimeType: "image/png", timestampMs: time });
    }
    const selected = buffer.capture(1200, 1800);
    expect(selected.frames.map((frame) => frame.timestampMs)).toEqual([1200, 1500, 1800]);
    selected.release();
  });
});
