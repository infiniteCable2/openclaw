import { encodePngRgba } from "rastermill";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SpeechAudioTransport, SpeechVideoFrame } from "./transport.js";
import { createSpeechVideoInput } from "./video-input.js";

const imageMocks = vi.hoisted(() => ({ encode: vi.fn() }));
// mock-isolation: Exercise image admission/cancellation without starting native image workers.
vi.mock("../../media/image-processor.js", () => ({
  createImageProcessor: () => ({ encode: imageMocks.encode }),
}));

const png = encodePngRgba(new Uint8Array([10, 20, 30, 255]), 1, 1);
const jpeg = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffc00011080001000103012200021101031101ffd9",
  "hex",
);

function fixture(enabled = true, profile: "source" | "preview" = "source") {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-01T12:00:00Z"));
  let onFrame: ((frame: SpeechVideoFrame) => void) | undefined;
  const startVideoInput = vi.fn<NonNullable<SpeechAudioTransport["startVideoInput"]>>((handler) => {
    onFrame = handler;
  });
  const transport: SpeechAudioTransport = {
    onFatal() {},
    startInput() {},
    startVideoInput,
    stop: async () => {},
    dispose: async () => {},
    clearOutput: async () => {},
    writeOutput: async () => {},
  };
  const input = createSpeechVideoInput({
    enabled,
    preview: { profile, targetBytes: 4096, maxSide: 64 },
    intervalMs: 250,
    retentionMs: 5000,
  });
  return {
    input,
    transport,
    startVideoInput,
    frame: () => onFrame?.({ data: png, mimeType: "image/png", timestampMs: Date.now() }),
  };
}

describe("speech video input snapshot ownership", () => {
  afterEach(() => vi.useRealTimers());

  it("does not acquire a video source when disabled", async () => {
    const f = fixture(false);
    await f.input.start(f.transport, vi.fn());
    expect(f.startVideoInput).not.toHaveBeenCalled();
    expect(f.input.capture(0)).toBeUndefined();
    f.input.close();
  });

  it("requires the configured transport capability", async () => {
    const f = fixture();
    const audioOnly = { ...f.transport, startVideoInput: undefined };
    await expect(f.input.start(audioOnly, vi.fn())).rejects.toThrow("does not support");
    f.input.close();
  });

  it("materializes native image parts and context from the exact registered snapshot", async () => {
    const f = fixture();
    try {
      await f.input.start(f.transport, vi.fn());
      f.frame();
      const snapshot = f.input.capture(Date.now() - 1000)!;
      expect(f.input.resolve(snapshot)).toBe(snapshot);
      expect(f.input.resolve({ frames: snapshot.frames })).toBeUndefined();
      const prepared = await f.input.prepare(snapshot);
      expect(prepared.images).toEqual([
        { type: "image", mimeType: "image/png", data: png.toString("base64") },
      ]);
      expect(prepared.context).toContain(snapshot.frames[0]!.id);
      expect(prepared.context).toContain("2025-01-01T12:00:00.000Z");
      snapshot.release();
      snapshot.release();
      expect(f.input.resolve(snapshot)).toBeUndefined();
      await expect(f.input.prepare(snapshot)).rejects.toThrow("no longer active");
    } finally {
      f.input.close();
    }
  });

  it("honors cancellation before preparation and closes retained snapshots", async () => {
    const f = fixture();
    await f.input.start(f.transport, vi.fn());
    f.frame();
    const snapshot = f.input.capture(Date.now() - 1000)!;
    const controller = new AbortController();
    controller.abort(new Error("synthetic input cancelled"));
    await expect(f.input.prepare(snapshot, controller.signal)).rejects.toThrow("input cancelled");
    f.input.close();
    expect(f.input.resolve(snapshot)).toBeUndefined();
    await expect(f.input.prepare(snapshot)).rejects.toThrow();
    f.frame();
    expect(f.input.capture(0)).toBeUndefined();
  });

  it("rechecks admission after an asynchronous source acquisition", async () => {
    const f = fixture();
    const acquisition = createDeferred();
    const assertCurrent = vi.fn();
    f.startVideoInput.mockImplementationOnce(() => acquisition.promise);
    const starting = f.input.start(f.transport, assertCurrent);
    f.input.close();
    assertCurrent.mockImplementation(() => {
      throw new Error("synthetic owner closed");
    });
    acquisition.resolve();
    await expect(starting).rejects.toThrow("owner closed");
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("preserves the utterance's early view beyond the rolling retention interval", async () => {
    const f = fixture();
    try {
      await f.input.start(f.transport, vi.fn());
      const beginning = Date.now();
      f.input.begin("long", beginning);
      f.frame();
      vi.setSystemTime(beginning + 10_000);
      f.frame();
      const snapshot = f.input.capture(beginning, Date.now(), "long")!;
      expect(snapshot.frames.map((frame) => frame.timestampMs)).toEqual([
        beginning,
        beginning + 10_000,
      ]);
      expect((await f.input.prepare(snapshot)).images).toHaveLength(2);
      snapshot.release();
    } finally {
      f.input.close();
    }
  });

  it("merges frame custody without changing native adjacent-text batching", async () => {
    const f = fixture();
    try {
      await f.input.start(f.transport, vi.fn());
      f.frame();
      const first = f.input.capture(Date.now(), Date.now())!;
      vi.setSystemTime(Date.now() + 1000);
      f.frame();
      const second = f.input.capture(Date.now(), Date.now())!;
      expect(f.input.mergeKey(first)).toBe(f.input.mergeKey(second));
      const merged = f.input.merge(first, second)!;
      expect(f.input.resolve(first)).toBeUndefined();
      expect(f.input.resolve(second)).toBeUndefined();
      expect((await f.input.prepare(merged)).images).toHaveLength(2);
      merged.release();
      expect(f.input.resolve(merged)).toBeUndefined();
    } finally {
      f.input.close();
    }
  });

  it("omits an oversized preview explicitly without dropping the spoken request", async () => {
    const f = fixture(true, "preview");
    imageMocks.encode.mockResolvedValueOnce({
      data: Buffer.concat([jpeg, Buffer.alloc(4097 - jpeg.length)]),
      width: 1,
      height: 1,
    });
    try {
      await f.input.start(f.transport, vi.fn());
      f.frame();
      await expect(f.input.prepare(f.input.capture(Date.now()))).resolves.toMatchObject({
        images: [],
        context: expect.stringContaining("preview(s) unavailable"),
      });
    } finally {
      f.input.close();
    }
  });

  it("cancels an in-flight preview worker when its session closes", async () => {
    const f = fixture(true, "preview");
    const entered = createDeferred<AbortSignal>();
    const encoded = createDeferred<{ data: Buffer; width: number; height: number }>();
    imageMocks.encode.mockImplementationOnce((_input: Buffer, options: { signal: AbortSignal }) => {
      entered.resolve(options.signal);
      return encoded.promise;
    });
    await f.input.start(f.transport, vi.fn());
    f.frame();
    const preparation = f.input.prepare(f.input.capture(Date.now()));
    const rejected = expect(preparation).rejects.toThrow();
    const signal = await entered.promise;
    expect(signal.aborted).toBe(false);
    f.input.close();
    expect(signal.aborted).toBe(true);
    encoded.resolve({ data: png, width: 1, height: 1 });
    await rejected;
  });
});
