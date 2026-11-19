import { describe, expect, it } from "vitest";
import { CONVERSATION_KNOWLEDGE_SEED } from "./conversation-knowledge-context-kinds.js";
import {
  isConversationKnowledgeSeedSuffix,
  resolveConversationKnowledgeSeedSuffixRead,
} from "./conversation-knowledge-seed-suffix.js";
import type { SessionTranscriptRawDeltaResult } from "./session-accessor.types.js";

function page(): Extract<SessionTranscriptRawDeltaResult, { kind: "page" }> {
  return {
    kind: "page",
    cursor: "",
    hasMore: false,
    serializedBytes: 500,
    events: [
      { seq: 21, event: { type: "custom", id: "prepared" } },
      {
        seq: 22,
        event: {
          type: "custom_message",
          id: "seed",
          parentId: "prepared",
          customType: CONVERSATION_KNOWLEDGE_SEED,
          display: false,
          details: { version: 1, complete: true },
        },
      },
    ],
  };
}

describe("prepared knowledge with a seed suffix", () => {
  it("accepts only the current linear metadata suffix back to the prepared boundary", () => {
    expect(isConversationKnowledgeSeedSuffix(page(), 21, 22)).toBe(true);
    expect(
      resolveConversationKnowledgeSeedSuffixRead({
        agentId: "main",
        sessionId: "root",
        generation: "stable",
        fromSeq: 21,
        throughSeq: 22,
      }),
    ).toMatchObject({ maxEvents: 2, maxBytes: 32_768 });
  });

  it.each([
    { parentId: "different" },
    { display: true },
    { customType: "openclaw.conversation-knowledge-checkpoint.v1" },
    { customType: "openclaw.conversation-utterance.v1" },
    { type: "reset" },
    { details: { version: 1, complete: false } },
  ])("refuses a suffix changed by %j", (change) => {
    const value = page();
    Object.assign(value.events[1]!.event, change);
    expect(isConversationKnowledgeSeedSuffix(value, 21, 22)).toBe(false);
  });

  it("refuses a truncated range, gap or rewritten generation", () => {
    const value = page();
    expect(isConversationKnowledgeSeedSuffix(value, 21, 23)).toBe(false);
    value.events[1]!.seq = 23;
    expect(isConversationKnowledgeSeedSuffix(value, 21, 22)).toBe(false);
    expect(
      isConversationKnowledgeSeedSuffix(
        { kind: "reset", cursor: "", reason: "generation_mismatch" },
        21,
        22,
      ),
    ).toBe(false);
  });
});
