import { describe, expect, it } from "vitest";
import type { SpeechUtterance } from "./output.js";
import { captureSpeechPlaybackObservation } from "./playback-observation.js";

function fixture() {
  const utterance: SpeechUtterance = {
    generation: 7,
    waitingGeneration: 0,
    chunks: ["Private speech"],
    transcriptEntries: [
      { at: "2026-01-01T00:00:00Z", role: "assistant", text: "One", audioDelivery: "submitted" },
      { at: "2026-01-01T00:00:00Z", role: "assistant", text: "Two", audioDelivery: "unplayed" },
      {
        at: "2026-01-01T00:00:00Z",
        role: "assistant",
        text: "Three",
        audioDelivery: "interrupted",
      },
    ],
    playbackStarted: true,
    finalized: true,
    failed: false,
  };
  return {
    source: {
      binding: { runId: "run-original", sessionId: "session-original" },
      inputId: "input-original",
      generation: 7,
      utterance,
    },
    runActive: false,
    playbackActive: false,
    onsetAtMs: 1234,
  };
}

describe("native speech playback observation", () => {
  it("reports handoff and interruption as media facts without hearing or work-completion claims", () => {
    const result = captureSpeechPlaybackObservation(fixture());
    expect(result).toEqual({
      onsetAtMs: 1234,
      preceding: {
        runId: "run-original",
        sessionId: "session-original",
        inputId: "input-original",
        outputGeneration: 7,
        runActiveAtOnset: false,
        playbackActiveAtOnset: false,
        playbackStarted: true,
        pendingOutput: true,
        unplayedResult: false,
        failed: false,
        segments: { submitted: 1, unplayed: 1, interrupted: 1, started: 0 },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/Private speech|One|Two|Three|completed|heard/);
  });
  it("does not let later playback mutations rewrite the original onset observation", () => {
    const params = fixture();
    const result = captureSpeechPlaybackObservation(params);
    params.source.utterance.transcriptEntries[1]!.audioDelivery = "started";
    params.source.generation = 8;
    expect(result?.preceding.outputGeneration).toBe(7);
    expect(result?.preceding.segments).toMatchObject({ unplayed: 1, started: 0 });
  });
  it("describes an active run awaiting its first output without inventing played speech", () => {
    const params = fixture();
    params.source.utterance.chunks = [];
    params.source.utterance.transcriptEntries = [];
    params.source.utterance.playbackStarted = false;
    params.runActive = true;
    expect(captureSpeechPlaybackObservation(params)?.preceding).toMatchObject({
      pendingOutput: true,
      playbackStarted: false,
      runActiveAtOnset: true,
      segments: { started: 0, submitted: 0, interrupted: 0, unplayed: 0 },
    });
  });
  it("fails closed on unusable original identity instead of truncating it into another reference", () => {
    const params = fixture();
    params.source.binding.runId = "x".repeat(257);
    expect(captureSpeechPlaybackObservation(params)).toBeUndefined();
  });
  it("keeps an actually unplayed buffered result visible after its native run has settled", () => {
    const params = fixture();
    params.source.utterance.chunks = [];
    params.source.utterance.transcriptEntries = [];
    expect(
      captureSpeechPlaybackObservation({
        ...params,
        source: { ...params.source, unplayedResult: true },
      })?.preceding,
    ).toMatchObject({ runActiveAtOnset: false, unplayedResult: true, pendingOutput: true });
  });
});
