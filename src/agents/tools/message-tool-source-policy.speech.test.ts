import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { MESSAGE_TOOL_SPEECH_PROPERTIES, MessageToolSchema } from "./message-tool-schema.js";
import { enforceSourceReplyOnlyMessageAction } from "./message-tool-source-policy.js";

describe("native current-source speech schema", () => {
  it("keeps canonical speech fields in the stable schema while guarding per-call grants", () => {
    const schema = MessageToolSchema;
    expect(schema.properties.voiceText).toEqual(MESSAGE_TOOL_SPEECH_PROPERTIES.voiceText);
    expect(schema.properties.voiceExpression).toEqual(
      MESSAGE_TOOL_SPEECH_PROPERTIES.voiceExpression,
    );
    expect(schema.properties).toHaveProperty("replyPhase");
    expect(() =>
      enforceSourceReplyOnlyMessageAction({
        action: "send",
        args: { action: "send", voiceProvider: "other" },
        currentSourceReplyTarget: {
          runId: "run-example",
          sessionId: "session-example",
          speechUtteranceOnly: true,
          assertCurrent() {},
          async deliver() {},
        },
      }),
    ).toThrow('cannot use the "voiceProvider" argument');
  });

  it("tolerates but discards optional disabled controls without granting speech text", () => {
    const schema = MessageToolSchema;
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
