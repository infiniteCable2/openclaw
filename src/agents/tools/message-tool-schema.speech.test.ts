import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { MESSAGE_TOOL_SPEECH_PROPERTIES } from "./message-tool-schema.js";

describe("model-facing speech expression schema", () => {
  it("admits emotion changes on text parts, not on event parts", () => {
    expect(
      Value.Check(MESSAGE_TOOL_SPEECH_PROPERTIES.voiceExpression, {
        emotion: "joyful",
        parts: [{ text: "Hello. " }, { text: "A quiet moment.", emotion: "sad" }],
      }),
    ).toBe(true);
    expect(
      Value.Check(MESSAGE_TOOL_SPEECH_PROPERTIES.voiceExpression, {
        parts: [{ event: "laugh", emotion: "sad" }],
      }),
    ).toBe(false);
  });
});
