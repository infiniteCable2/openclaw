import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { ConversationListItemSchema } from "../../packages/gateway-protocol/src/schema/agent.js";
import type { ChannelCapabilities } from "../channels/plugins/types.core.js";
import type { ConversationRecord } from "../config/sessions/conversation-registry.types.js";
import { presentConversationList } from "./conversation-list-presentation.js";

const conversation: ConversationRecord = {
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  channel: "reef",
  accountId: "default",
  kind: "direct",
  peerId: "peer-1",
  target: "reef:peer-1",
  label: "Example chat",
  threadId: "thread-1",
  contextRelation: "parent",
  sessionKey: "agent:example:main",
  sessionId: "context-1",
  role: "primary",
  observedFromSession: true,
  firstSeenAt: 100,
  lastSeenAt: 200,
};

function plugin(capabilities: ChannelCapabilities) {
  return {
    meta: {
      id: "reef",
      label: " Reef Chat ",
      selectionLabel: "Reef Chat",
      docsPath: "/channels/reef",
      blurb: "Example channel",
    },
    capabilities,
  };
}

function presentItem(entry: ConversationRecord, channel?: ReturnType<typeof plugin>) {
  return expectDefined(
    presentConversationList([entry], () => channel)[0],
    "presented conversation",
  );
}

describe("conversation list presentation", () => {
  it("resolves only selected channel metadata once per response, including missing plugins", () => {
    const selected = [
      conversation,
      { ...conversation, target: "reef:peer-2" },
      { ...conversation, channel: "missing", target: "missing:peer-1" },
      { ...conversation, channel: "missing", target: "missing:peer-2" },
    ];
    const resolveChannel = vi.fn((channel: string) =>
      channel === "reef" ? plugin({ chatTypes: ["direct"], media: true }) : undefined,
    );
    const result = presentConversationList(selected, resolveChannel);
    expect(resolveChannel.mock.calls).toEqual([["reef"], ["missing"]]);
    expect(result.map((row) => row.channelLabel)).toEqual([
      "Reef Chat",
      "Reef Chat",
      undefined,
      undefined,
    ]);
    // There is no process-global metadata cache across registry replacements.
    const replacement = vi.fn(() => plugin({ chatTypes: ["direct"], media: false }));
    const replacementResult = expectDefined(
      presentConversationList([conversation], replacement)[0],
      "replacement conversation",
    );
    expect(replacementResult.channelCapabilities).toEqual({
      media: false,
    });
    expect(replacement).toHaveBeenCalledExactlyOnceWith("reef");
  });

  it("keeps durable address facts without leaking session bindings or inventing presence", () => {
    const result = presentItem(conversation);
    expect(result).toEqual({
      conversationRef: conversation.conversationRef,
      channel: "reef",
      accountId: "default",
      kind: "direct",
      target: "reef:peer-1",
      label: "Example chat",
      threadId: "thread-1",
      contextRelation: "parent",
      firstSeenAt: 100,
      lastSeenAt: 200,
    });
    expect(Value.Check(ConversationListItemSchema, result)).toBe(true);
  });

  it.each([true, false])("preserves the exact declared media capability %s", (media) => {
    const result = presentItem(conversation, plugin({ chatTypes: ["direct"], media }));
    expect(result.channelLabel).toBe("Reef Chat");
    expect(result.channelCapabilities).toEqual({ media });
    expect(Value.Check(ConversationListItemSchema, result)).toBe(true);
  });

  it.each(["audio-file", "voice-note"] as const)(
    "reports the native voice output format %s without deriving another delivery grant",
    (synthesisTarget) => {
      const result = presentItem(
        conversation,
        plugin({ chatTypes: ["direct"], tts: { voice: { synthesisTarget } } }),
      );
      expect(result.channelCapabilities).toEqual({ voiceOutput: synthesisTarget });
      expect(Value.Check(ConversationListItemSchema, result)).toBe(true);
    },
  );

  it("omits undeclared media capabilities rather than declaring unsupported formats", () => {
    const result = presentItem(conversation, plugin({ chatTypes: ["direct"] }));
    expect(result.channelLabel).toBe("Reef Chat");
    expect(result).not.toHaveProperty("channelCapabilities");
  });

  it("rejects unsupported capability and presence claims at the wire boundary", () => {
    const result = presentItem(conversation);
    expect(
      Value.Check(ConversationListItemSchema, { ...result, channelCapabilities: { video: true } }),
    ).toBe(false);
    expect(
      Value.Check(ConversationListItemSchema, { ...result, channelCapabilities: { media: "yes" } }),
    ).toBe(false);
    expect(
      Value.Check(ConversationListItemSchema, {
        ...result,
        channelCapabilities: { voiceOutput: "realtime-audio" },
      }),
    ).toBe(false);
    expect(Value.Check(ConversationListItemSchema, { ...result, online: true })).toBe(false);
  });
});
