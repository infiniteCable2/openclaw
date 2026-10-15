import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { MESSAGE_TOOL_SPEECH_PROPERTIES } from "./message-tool-schema.js";
import {
  buildSourceReplyOnlyMessageSchema,
  enforceSourceReplyOnlyMessageAction,
} from "./message-tool-source-policy.js";

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

  it("tolerates but discards optional disabled controls without granting speech text", () => {
    const schema = buildSourceReplyOnlyMessageSchema(false, false);
    expect(schema.properties).not.toHaveProperty("voiceText");
    expect(schema.properties).not.toHaveProperty("replyPhase");
    const args = {
      action: "send",
      message: "Plain current-source answer.",
      voiceExpression: { emotion: "unsupported", parts: [{ text: "Mismatched words." }] },
    };
    expect(Value.Check(schema, args)).toBe(true);
    enforceSourceReplyOnlyMessageAction({
      action: "send",
      args,
      currentChannelProvider: "matrix",
      currentChannelId: "room:example",
    });
    expect(args).not.toHaveProperty("voiceExpression");
    expect(args.message).toBe("Plain current-source answer.");
    expect(() =>
      enforceSourceReplyOnlyMessageAction({
        action: "send",
        args: { ...args, voiceText: "Not granted." },
        currentChannelProvider: "matrix",
        currentChannelId: "room:example",
      }),
    ).toThrow('cannot use the "voiceText" argument');
  });
});
