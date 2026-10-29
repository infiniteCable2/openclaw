import { describe, expect, it } from "vitest";
import { selectConversationKnowledgeReceipts } from "./conversation-knowledge-selection.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReceipt,
} from "./conversation-knowledge.js";
function fixture(suffix = "alpha") {
  const source = {
    agentId: "researcher",
    sessionKey: `agent:researcher:example:${suffix}`,
    sessionId: `session-${suffix}`,
    lifecycleRevision: "original",
  };
  const receipt: ConversationKnowledgeReceipt = {
    version: 1,
    sourceMode: "branches",
    origin: conversationKnowledgeOrigin(source),
    source,
    runId: `run-${suffix}`,
    through: {
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      sessionId: source.sessionId,
      storePath: "/synthetic/agent.sqlite",
      generation: "generation-original",
      entryId: "answer",
      rawSeq: 4,
      activeMessagePosition: 2,
      effectiveParentId: "question",
    },
  };
  const events = [
    { type: "session", id: source.sessionId },
    {
      type: "message",
      id: "question",
      message: { role: "user", content: "Remember the blue example." },
    },
    {
      type: "message",
      id: "answer",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The example is blue." }],
        stopReason: "stop",
        __openclaw: { runId: receipt.runId },
      },
    },
  ];
  return { source, receipt, events };
}

function privateFixture() {
  const f = fixture();
  const receipt: ConversationKnowledgeReceipt = {
    ...f.receipt,
    privateAudience: {
      participant: { type: "profile", id: "person-alpha" },
      admission: {
        ...f.receipt.through,
        entryId: "question",
        rawSeq: 2,
        activeMessagePosition: 1,
        effectiveParentId: f.source.sessionId,
      },
    },
  };
  return { ...f, receipt };
}

describe("historical reset candidate selection", () => {
  it("keeps historical reset ranges of the same transcript as candidates, but fences replacements", () => {
    const f = privateFixture();
    const nextSource = { ...f.source, lifecycleRevision: "after-reset" };
    const next = {
      ...f.receipt,
      source: nextSource,
      origin: conversationKnowledgeOrigin(nextSource),
    };
    const event = (details: ConversationKnowledgeReceipt) => ({
      type: "custom_message",
      customType: CONVERSATION_KNOWLEDGE_REPORT,
      details,
    });
    expect(selectConversationKnowledgeReceipts([event(f.receipt), event(next)], "other")).toEqual([
      f.receipt,
      next,
    ]);
    expect(
      selectConversationKnowledgeReceipts(
        [event(f.receipt), event(next)],
        f.source.sessionId,
        f.source.sessionKey,
        "branches",
        nextSource.lifecycleRevision,
      ),
    ).toEqual([f.receipt]);
    const replacedSource = { ...nextSource, sessionId: "replacement-session" };
    const replacement = {
      ...next,
      source: replacedSource,
      origin: conversationKnowledgeOrigin(replacedSource),
      through: { ...next.through, sessionId: replacedSource.sessionId },
      privateAudience: {
        ...next.privateAudience!,
        admission: { ...next.privateAudience!.admission, sessionId: replacedSource.sessionId },
      },
    };
    expect(
      selectConversationKnowledgeReceipts(
        [event(f.receipt), event(next), event(replacement)],
        "other",
      ),
    ).toEqual([replacement]);
  });
});
