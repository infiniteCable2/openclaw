import { describe, expect, it } from "vitest";
import { planCommunicationMediaRoute } from "./communication-route.js";

describe("communication media route", () => {
  const base = {
    source: ["audio", "video"] as const,
    target: { input: ["text", "image"] as const, output: ["text"] as const },
    output: "audio" as const,
    converters: { stt: true, tts: true, videoFrames: true },
  };
  it("chooses only required conversions, without selecting another model", () => {
    expect(planCommunicationMediaRoute(base)).toEqual({
      kind: "ready",
      steps: ["stt", "video-frames", "tts"],
      unsupported: [],
    });
  });
  it("does not transcribe or synthesize when the actual adapter supports native audio", () => {
    expect(
      planCommunicationMediaRoute({
        ...base,
        target: { input: ["audio", "video"], output: ["audio"] },
      }),
    ).toEqual({ kind: "ready", steps: [], unsupported: [] });
  });
  it.each(["recording", "relay"] as const)("does not analyze or convert %s", (purpose) => {
    expect(planCommunicationMediaRoute({ ...base, purpose })).toEqual({
      kind: "passthrough",
      steps: [],
      unsupported: [],
    });
  });
  it("reports unsupported modalities instead of dropping them or changing models", () => {
    expect(
      planCommunicationMediaRoute({
        ...base,
        converters: { stt: false, tts: false, videoFrames: false },
      }),
    ).toEqual({ kind: "unsupported", steps: [], unsupported: ["audio", "video"] });
  });
});
