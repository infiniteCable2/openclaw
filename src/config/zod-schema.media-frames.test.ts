import { describe, expect, it } from "vitest";
import { SpeechVideoSchema, VideoFrameExtractionSchema } from "./zod-schema.media-frames.js";

describe("bounded media frame configuration", () => {
  it("keeps extraction and live sampling opt-in with shared rendition profiles", () => {
    expect(
      VideoFrameExtractionSchema.parse({
        enabled: true,
        maxFrames: 3,
        profile: "preview",
        targetBytes: 150000,
      }),
    ).toMatchObject({ enabled: true, maxFrames: 3 });
    expect(
      SpeechVideoSchema.parse({ enabled: true, intervalMs: 1000, preview: { profile: "source" } }),
    ).toMatchObject({ enabled: true });
  });
  it.each([
    { maxFrames: 0 },
    { maxFrames: 13 },
    { targetBytes: 0 },
    { maxSide: 999999 },
    { profile: "original-url" },
    { enabled: true, command: "custom" },
  ])("rejects unsafe extraction policy %j", (value) => {
    expect(VideoFrameExtractionSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    { intervalMs: 1 },
    { retentionMs: Infinity },
    { maxFramesPerTurn: 100 },
    { maxSourceBytes: -1 },
    { maxBufferBytes: 2 ** 31 },
  ])("rejects unbounded live source policy %j", (value) => {
    expect(SpeechVideoSchema.safeParse({ enabled: true, ...value }).success).toBe(false);
  });
});
