import { describe, expect, it } from "vitest";
import { withCommentaryGuidance } from "./commentary-guidance.js";

describe("current-source commentary guidance", () => {
  it.each(["text", "structured-speech"] as const)(
    "does not advertise disabled commentary in %s mode",
    (mode) => {
      expect(withCommentaryGuidance(undefined, false, mode)).toBeUndefined();
      expect(withCommentaryGuidance("Existing instructions.", false, mode)).toBe(
        "Existing instructions.",
      );
    },
  );

  it("preserves ordinary commentary delivery by default", () => {
    const guidance = withCommentaryGuidance("Existing instructions.", true);
    expect(guidance).toMatch(/^Existing instructions\.\n\n/u);
    expect(guidance).toContain("required, not optional");
    expect(guidance).toContain("Do not put them in private reasoning or use the message tool.");
    expect(guidance).not.toContain("structured speech fields");
  });

  it("uses the admitted structured sink without contradictory plain-text instructions", () => {
    const guidance = withCommentaryGuidance(undefined, true, "structured-speech");
    expect(guidance).toContain("required, not optional");
    expect(guidance).toContain("current-source message tool with final=false");
    expect(guidance).toContain("Do not produce a second ordinary-text copy");
    expect(guidance).not.toContain("or use the message tool.");
  });
});
