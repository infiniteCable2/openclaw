import { describe, expect, it } from "vitest";
import { buildSpeechExpressionGuidance } from "./expression-guidance.js";

const capabilities = {
  emotions: ["tender", "joyful", "tender"],
  vocalEvents: ["sigh", "laugh"],
  emphasis: true,
  whisper: false,
};

describe("admitted speech expression guidance", () => {
  it("renders deterministic actual vocabulary without modifying the provider facts", () => {
    const original = structuredClone(capabilities);
    const guidance = buildSpeechExpressionGuidance({
      capabilities,
      target: "telephony",
      currentSourceSpeechTarget: true,
      commentaryEnabled: true,
    });
    expect(guidance).toContain('Emotion identifiers: ["joyful","tender"]');
    expect(guidance).toContain('Vocal event identifiers: ["laugh","sigh"]');
    expect(guidance).toContain("Emphasis: supported");
    expect(guidance).toContain('replyPhase="commentary" and final=false');
    expect(guidance).toContain("event parts contribute no visible text");
    expect(guidance).toContain("Do not write Kitten tags");
    expect(guidance).toContain("Speech controls are optional");
    expect(guidance).toContain("plain utterances without expression controls");
    expect(guidance).not.toContain("Include a structured plan even for a neutral utterance");
    expect(capabilities).toEqual(original);
  });

  it("distinguishes answer sentences from disabled commentary", () => {
    const guidance = buildSpeechExpressionGuidance({
      capabilities,
      target: "telephony",
      currentSourceSpeechTarget: true,
      commentaryEnabled: false,
    });
    expect(guidance).toContain("final=false is still final_answer");
    expect(guidance).toContain("do not send commentary utterances");
    expect(guidance).not.toContain('use replyPhase="commentary"');
  });

  it("does not advertise speech-target-only fields to an ordinary channel send", () => {
    const guidance = buildSpeechExpressionGuidance({
      capabilities: { ...capabilities, emphasis: false },
      target: "voice-note",
      currentSourceSpeechTarget: false,
      commentaryEnabled: true,
    });
    expect(guidance).toContain("output target is voice-note");
    expect(guidance).toContain("Emphasis: unsupported");
    expect(guidance).toContain(
      "Ordinary assistant replies use the configured automatic speech delivery",
    );
    expect(guidance).not.toContain("replyPhase");
  });
});
