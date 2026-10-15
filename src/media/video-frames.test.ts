import fs from "node:fs/promises";
import path from "node:path";
import { encodePngRgba } from "rastermill";
import { describe, expect, it, vi } from "vitest";
import type { BufferedCommandResult } from "../process/exec.js";
import {
  buildVideoOverviewTimestamps,
  createVideoFrameExtractor,
  MAX_VIDEO_FRAME_COUNT,
  renderVideoFrameBuffer,
} from "./video-frames.js";

const movie = Buffer.from("000000186674797069736f6d0000020069736f6d", "hex");
const png = encodePngRgba(new Uint8Array([20, 40, 60, 255]), 1, 1);
// Only image-header probing is in scope; no native codec runs in this fixture.
const jpeg = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffc00011080001000103012200021101031101ffd9",
  "hex",
);
const metadata = {
  streams: [
    { codec_type: "video", width: 1280, height: 720, disposition: { attached_pic: 0 } },
    { codec_type: "audio" },
  ],
  format: { duration: "12.5" },
};

function exited(stdout: Buffer): BufferedCommandResult {
  return {
    stdout,
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

function fixture() {
  const runCommand = vi.fn(async (argv: string[]) =>
    exited(argv[0] === "ffprobe" ? Buffer.from(JSON.stringify(metadata)) : png),
  );
  const encodePreview = vi.fn(async () => jpeg);
  const extractor = createVideoFrameExtractor({
    runCommand,
    resolveFfmpeg: () => "ffmpeg",
    resolveFfprobe: () => "ffprobe",
    encodePreview,
  });
  return { ...extractor, runCommand, encodePreview };
}

describe("bounded video frame extraction", () => {
  it("probes a private seekable copy, rejects external references, and cleans it", async () => {
    const test = fixture();
    let inputPath = "";
    test.runCommand.mockImplementationOnce(async (argv) => {
      inputPath = argv[argv.indexOf("-i") + 1]!;
      expect(await fs.readFile(inputPath)).toEqual(movie);
      if (process.platform !== "win32") {
        expect((await fs.stat(inputPath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.dirname(inputPath))).mode & 0o777).toBe(0o700);
      }
      expect(argv).toEqual(
        expect.arrayContaining([
          "-protocol_whitelist",
          "file,pipe",
          "-format_whitelist",
          "mov",
          "-f",
          "mov",
          "-enable_drefs",
          "0",
          "-use_absolute_path",
          "0",
        ]),
      );
      return exited(Buffer.from(JSON.stringify(metadata)));
    });
    await expect(test.probeVideoBuffer({ buffer: movie })).resolves.toEqual({
      container: "mov",
      durationSeconds: 12.5,
      width: 1280,
      height: 720,
      hasAudio: true,
    });
    await expect(fs.access(path.dirname(inputPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(movie.toString("hex")).toBe("000000186674797069736f6d0000020069736f6d");
  });

  it.each([
    ["matroska", Buffer.from("1a45dfa30000", "hex")],
    ["avi", Buffer.from("RIFFxxxxAVI ")],
  ])("forces the recognized %s demuxer", async (container, buffer) => {
    const test = fixture();
    await expect(test.probeVideoBuffer({ buffer })).resolves.toMatchObject({ container });
    expect(test.runCommand.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["-format_whitelist", container, "-f", container]),
    );
  });

  it.each([Buffer.alloc(0), Buffer.from("https://example.invalid/video"), Buffer.from("#EXTM3U")])(
    "rejects unsupported input before process admission",
    async (buffer) => {
      const test = fixture();
      await expect(test.probeVideoBuffer({ buffer })).rejects.toThrow();
      expect(test.runCommand).not.toHaveBeenCalled();
    },
  );

  it("extracts ordered requested timestamps with binary output caps and bounded previews", async () => {
    const test = fixture();
    const frames = await test.extractVideoFrames({
      buffer: movie,
      timestampsSeconds: [7.25, 1.5],
      profile: "detail",
      maxSide: 1600,
      targetBytes: 80_000,
    });
    expect(frames).toEqual(
      [7.25, 1.5].map((timestampSeconds) => ({
        timestampSeconds,
        buffer: jpeg,
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
      })),
    );
    expect(test.encodePreview).toHaveBeenCalledTimes(2);
    expect(test.encodePreview).toHaveBeenCalledWith(png, {
      maxSide: 1600,
      targetBytes: 80_000,
      signal: expect.any(AbortSignal),
    });
    const command = test.runCommand.mock.calls[1];
    expect(command?.[0]).toEqual(
      expect.arrayContaining(["-ss", "7.25", "-map", "0:V:0", "-frames:v", "1", "pipe:1"]),
    );
  });

  it("returns the full decoded PNG without any second encode for source", async () => {
    const test = fixture();
    const frames = await test.extractVideoFrames({
      buffer: movie,
      timestampsSeconds: [0],
      profile: "source",
    });
    expect(frames[0]).toMatchObject({ buffer: png, mimeType: "image/png", width: 1, height: 1 });
    expect(test.encodePreview).not.toHaveBeenCalled();
  });

  it.each(
    [[], [-1], [Number.NaN], Array<number>(MAX_VIDEO_FRAME_COUNT + 1).fill(0)].map(
      (timestampsSeconds) => ({ timestampsSeconds }),
    ),
  )("rejects invalid timestamp selections without spawning", async ({ timestampsSeconds }) => {
    const test = fixture();
    await expect(test.extractVideoFrames({ buffer: movie, timestampsSeconds })).rejects.toThrow();
    expect(test.runCommand).not.toHaveBeenCalled();
  });

  it("does not decode a timestamp at or beyond the file duration", async () => {
    const test = fixture();
    await expect(
      test.extractVideoFrames({ buffer: movie, timestampsSeconds: [12.5] }),
    ).rejects.toThrow("outside the video duration");
    expect(test.runCommand).toHaveBeenCalledOnce();
  });

  it.each([
    { streams: [], format: { duration: "2" } },
    { ...metadata, format: { duration: "NaN" } },
    { ...metadata, format: { duration: "90000" } },
    { ...metadata, streams: [{ codec_type: "video", width: 100_000, height: 100_000 }] },
    {
      ...metadata,
      streams: [{ codec_type: "video", width: 10, height: 10, disposition: { attached_pic: 1 } }],
    },
  ])("rejects unavailable video metadata or decoder pixel limits", async (invalid) => {
    const test = fixture();
    test.runCommand.mockResolvedValueOnce(exited(Buffer.from(JSON.stringify(invalid))));
    await expect(test.probeVideoBuffer({ buffer: movie })).rejects.toThrow();
  });

  it("ignores cover art and uses stream duration when format duration is absent", async () => {
    const test = fixture();
    test.runCommand.mockResolvedValueOnce(
      exited(
        Buffer.from(
          JSON.stringify({
            streams: [
              { codec_type: "video", width: 40, height: 40, disposition: { attached_pic: 1 } },
              { codec_type: "video", width: 640, height: 360, duration: "7.5" },
            ],
          }),
        ),
      ),
    );
    await expect(test.probeVideoBuffer({ buffer: movie })).resolves.toMatchObject({
      width: 640,
      height: 360,
      durationSeconds: 7.5,
      hasAudio: false,
    });
  });

  it("removes its private source on process failure without exposing diagnostics", async () => {
    const test = fixture();
    let inputPath = "";
    test.runCommand.mockImplementationOnce(async (argv) => {
      inputPath = argv[argv.indexOf("-i") + 1]!;
      return {
        ...exited(Buffer.alloc(0)),
        code: 1,
        stderr: Buffer.from("private path and metadata"),
      };
    });
    await expect(test.probeVideoBuffer({ buffer: movie })).rejects.toThrow(
      "Video processing failed (exit)",
    );
    await expect(fs.access(path.dirname(inputPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates cancellation before admission and between frames", async () => {
    const test = fixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled before admission"));
    await expect(
      test.probeVideoBuffer({ buffer: movie, signal: controller.signal }),
    ).rejects.toThrow("cancelled before admission");
    expect(test.runCommand).not.toHaveBeenCalled();
    const active = new AbortController();
    test.encodePreview.mockImplementationOnce(async () => {
      active.abort(new Error("cancelled during preview"));
      return jpeg;
    });
    await expect(
      test.extractVideoFrames({ buffer: movie, timestampsSeconds: [1, 2], signal: active.signal }),
    ).rejects.toThrow("cancelled during preview");
    expect(test.runCommand).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a process hits the bounded output budget", async () => {
    const test = fixture();
    test.runCommand.mockResolvedValueOnce({
      ...exited(Buffer.alloc(0)),
      code: null,
      termination: "output-limit",
    });
    await expect(test.probeVideoBuffer({ buffer: movie })).rejects.toThrow(
      "Video processing failed (output-limit)",
    );
  });

  it("fails closed on a missing decoded frame or oversized preview", async () => {
    const test = fixture();
    test.runCommand.mockResolvedValueOnce(exited(Buffer.from(JSON.stringify(metadata))));
    test.runCommand.mockResolvedValueOnce(exited(Buffer.alloc(0)));
    await expect(
      test.extractVideoFrames({ buffer: movie, timestampsSeconds: [0] }),
    ).rejects.toThrow("frame is missing");
    test.encodePreview.mockResolvedValueOnce(Buffer.concat([jpeg, Buffer.alloc(1024)]));
    await expect(
      test.extractVideoFrames({ buffer: movie, timestampsSeconds: [0], targetBytes: 1024 }),
    ).rejects.toThrow("requested image limits");
  });
});

describe("video overview positions", () => {
  it("covers the whole duration without seeking at the potentially empty endpoint", () => {
    expect(buildVideoOverviewTimestamps(12, 4)).toEqual([1.5, 4.5, 7.5, 10.5]);
    expect(buildVideoOverviewTimestamps(0.02, 1)).toEqual([0.01]);
  });

  it.each([0, -1, Number.NaN])("rejects invalid durations", (duration) => {
    expect(() => buildVideoOverviewTimestamps(duration)).toThrow();
  });
});

describe("shared live/file frame rendition", () => {
  it.each([
    [png, "image/png"],
    [jpeg, "image/jpeg"],
  ] as const)(
    "retains source bytes and their actual format without re-encoding",
    async (buffer, mimeType) => {
      const rendered = await renderVideoFrameBuffer({ buffer, profile: "source" });
      expect(rendered).toEqual({ buffer, mimeType, width: 1, height: 1 });
      expect(rendered.buffer).toBe(buffer);
    },
  );

  it("rejects unsupported or invalid source images before returning model-facing bytes", async () => {
    await expect(
      renderVideoFrameBuffer({ buffer: Buffer.from("not an image"), profile: "source" }),
    ).rejects.toThrow("frame is missing");
    await expect(
      renderVideoFrameBuffer({ buffer: png, profile: "source", maxSide: 0 }),
    ).rejects.toThrow("Frame maxSide");
  });

  it("honors cancellation even when source needs no image worker", async () => {
    const controller = new AbortController();
    controller.abort(new Error("synthetic frame cancelled"));
    await expect(
      renderVideoFrameBuffer({ buffer: png, profile: "source", signal: controller.signal }),
    ).rejects.toThrow("frame cancelled");
  });
});
