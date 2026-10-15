import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceSessionHarness } from "../realtime-session-harness.js";
import { createSpeechSessionControls } from "./session-controls.js";
import type { SpeechActiveConsult } from "./types.js";

function fixture() {
  let stopped = false;
  let consult: SpeechActiveConsult | undefined;
  const markInterruptedTranscript = vi.fn();
  const cancelActiveSpeech = vi.fn();
  const invalidateOutput = vi.fn();
  const finishOutputAudio = vi.fn();
  const controls = createSpeechSessionControls({
    harness: {
      isOutputPlaybackWindowActive: () => true,
      talk: { activeTurnId: "turn-current" } as RealtimeVoiceSessionHarness["talk"],
      flushOutput: (clear) => clear(),
      finishOutputAudio,
    },
    cancellation: { markInterruptedTranscript, cancelActiveSpeech },
    getConsult: () => consult,
    isStopped: () => stopped,
    getOutputGeneration: () => 2,
    getOutputTurnId: () => "turn-current",
    hasOutput: () => true,
    invalidateOutput,
  });
  return {
    controls,
    markInterruptedTranscript,
    cancelActiveSpeech,
    invalidateOutput,
    finishOutputAudio,
    stop: () => {
      stopped = true;
    },
    setConsult: (value: SpeechActiveConsult) => {
      consult = value;
    },
  };
}

describe("speech session controls", () => {
  it("cancels only the exact current output without aborting native work", () => {
    const f = fixture();
    expect(f.controls.cancelOutput({ turnId: "old" }).status).toBe("stale");
    expect(f.invalidateOutput).not.toHaveBeenCalled();
    expect(f.controls.cancelOutput().status).toBe("applied");
    expect(f.markInterruptedTranscript).toHaveBeenCalledOnce();
    expect(f.cancelActiveSpeech).toHaveBeenCalledOnce();
    f.stop();
    expect(f.controls.cancelOutput().status).toBe("idle");
  });
  it("preserves trusted image attachments when steering the exact native owner", async () => {
    const f = fixture();
    const control = vi.fn(async () => ({
      ok: true,
      queued: true,
      active: true,
      mode: "followup" as const,
      sessionKey: "test",
      message: "adopted",
      speak: false,
      show: false,
      suppress: false,
    }));
    const current: SpeechActiveConsult = {
      control,
      admissions: Promise.resolve(),
      adoptedGeneration: 1,
      unconfirmed: false,
      followupOnly: false,
      question: "question",
      releaseVideo: new Set(),
    };
    f.setConsult(current);
    const request = {
      text: "Look here",
      images: [{ type: "image" as const, data: "test", mimeType: "image/png" }],
    };
    await f.controls.steer(request);
    expect(control).toHaveBeenCalledWith(request.text, undefined, request);
    expect(current.adoptedGeneration).toBe(2);
  });
  it("does not inject after the owner closes while an earlier admission settles", async () => {
    const f = fixture();
    const control = vi.fn();
    const current: SpeechActiveConsult = {
      control,
      admissions: Promise.resolve(),
      adoptedGeneration: 1,
      unconfirmed: false,
      followupOnly: false,
      question: "question",
      releaseVideo: new Set(),
    };
    f.setConsult(current);
    const steering = f.controls.steer({ text: "addition" });
    f.stop();
    await expect(steering).rejects.toThrow("owner changed");
    expect(control).not.toHaveBeenCalled();
    expect(current.unconfirmed).toBe(true);
  });
});
