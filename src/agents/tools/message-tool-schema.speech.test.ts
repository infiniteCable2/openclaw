import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { parseSpeechExpression } from "../../tts/expression.js";
import { MessageToolSchema } from "./message-tool-schema.js";

describe("model-facing speech expression schema", () => {
  it("keeps enabled canonical validation strict after shared wire admission", () => {
    const expression = {
      emotion: "joyful",
      parts: [{ text: "Hello. " }, { text: "A quiet moment.", emotion: "sad" }],
    };
    const args = {
      action: "send",
      message: "Hello. A quiet moment.",
      voiceText: "Hello. A quiet moment.",
      voiceExpression: expression,
    };
    expect(Value.Check(MessageToolSchema, args)).toBe(true);
    expect(parseSpeechExpression(args.voiceExpression, args.voiceText)).toEqual(expression);
  });

  it.each([
    null,
    7,
    "unexpected controls",
    { unknown: "block" },
    { parts: [] },
    { parts: [{ text: "Different words." }] },
    { parts: [{ event: "laugh", emotion: "sad" }] },
  ])(
    "admits stale optional controls without rejecting the whole plain message: %j",
    (expression) => {
      const args = {
        action: "send",
        message: "Plain answer.",
        voiceText: "Plain answer.",
        voiceExpression: expression,
      };
      expect(Value.Check(MessageToolSchema, args)).toBe(true);
      // The shared schema cannot know whether this source has expression enabled.
      // Enabled execution still uses this exact parser; disabled execution drops it.
      expect(() => parseSpeechExpression(expression, args.voiceText)).toThrow();
    },
  );
});
