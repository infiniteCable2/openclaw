import { describe, expect, it } from "vitest";
import { MESSAGE_TOOL_SPEECH_PROPERTIES } from "./message-tool-schema.js";
import { buildSourceReplyOnlyMessageSchema } from "./message-tool-source-policy.js";

describe("native current-source speech schema", () => {
  it("takes exactly the canonical named speech fields without provider/voice grants", () => {
    const schema = buildSourceReplyOnlyMessageSchema(true, true);
    expect(schema.properties.voiceText).toEqual(MESSAGE_TOOL_SPEECH_PROPERTIES.voiceText);
    expect(schema.properties.voiceExpression).toEqual(
      MESSAGE_TOOL_SPEECH_PROPERTIES.voiceExpression,
    );
    expect(schema.properties).not.toHaveProperty("voiceProvider");
    expect(schema.properties).not.toHaveProperty("voiceId");
    expect(schema.properties).toHaveProperty("replyPhase");
  });

  it("keeps the ordinary restricted surface free of speech controls", () => {
    const schema = buildSourceReplyOnlyMessageSchema(false, false);
    expect(schema.properties).not.toHaveProperty("voiceText");
    expect(schema.properties).not.toHaveProperty("voiceExpression");
    expect(schema.properties).not.toHaveProperty("replyPhase");
  });
});
