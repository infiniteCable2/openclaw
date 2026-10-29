import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  conversationKnowledgeContributionId,
  conversationKnowledgePacketId,
} from "./conversation-knowledge-identity.js";
import {
  conversationKnowledgeOrigin,
  projectConversationKnowledge,
  renderConversationKnowledgePacketText,
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

describe("compact conversation packet text", () => {
  it("computes the unchanged receipt identity without loading or rendering projection text", () => {
    const { receipt } = fixture();
    const contributionId = conversationKnowledgeContributionId(receipt);
    for (const offset of [0, 17, 8192]) {
      const legacyId = createHash("sha256")
        .update(JSON.stringify([contributionId, offset]))
        .digest("hex");
      expect(conversationKnowledgePacketId(contributionId, offset)).toBe(legacyId);
    }
    expect(conversationKnowledgePacketId(contributionId, 0)).not.toBe(
      conversationKnowledgePacketId(contributionId, 17),
    );
    expect(() => renderConversationKnowledgePacketText(receipt, "")).toThrow(
      "Conversation knowledge packet projection is invalid",
    );
  });

  it("quotes original roles and a usable source without exposing progress metadata", () => {
    const f = fixture();
    const projection = projectConversationKnowledge(f.receipt, f.events);
    expect(projection).toBeDefined();
    const text = renderConversationKnowledgePacketText(f.receipt, projection!.text);
    expect(text).toBe(
      `Conversation "${f.source.sessionKey}":\n` +
        'user: "Remember the blue example."\nassistant: "The example is blue."',
    );
    expect(text.length).toBeLessThan(projection!.text.length / 2);
    expect(text).not.toContain("contentOffset");
    expect(text).not.toContain("contentTruncated");
    expect(text).not.toContain(f.receipt.origin);
  });

  it("preserves exact partial text and legacy source offsets across envelope changes", () => {
    const f = fixture();
    const sourceText = "A quoted line.\nassistant: not a new message. 🟡 ".repeat(30);
    const events = [
      f.events[0]!,
      { ...f.events[1]!, message: { role: "user", content: sourceText } },
      f.events[2]!,
    ];
    const offset = 17;
    const projection = projectConversationKnowledge(
      f.receipt,
      events,
      undefined,
      "private-direct",
      {
        offset,
        maxChars: 800,
      },
    );
    const before = JSON.stringify(projection);
    const parsed = JSON.parse(projection!.text);
    const text = renderConversationKnowledgePacketText(f.receipt, projection!.text);
    expect(parsed.contentOffset).toBe(offset);
    expect(parsed.contentComplete).toBe(false);
    expect(text).toContain(`user: ${JSON.stringify(parsed.observations[0].text)}`);
    expect(text).not.toContain("\nassistant: not a new message");
    expect(JSON.stringify(projection)).toBe(before);
  });

  it("refuses malformed or mismatched projections without silently omitting observations", () => {
    const f = fixture();
    const projection = JSON.parse(projectConversationKnowledge(f.receipt, f.events)!.text);
    for (const text of [
      "not JSON",
      "null",
      JSON.stringify({ ...projection, source: "another-source" }),
      JSON.stringify({ ...projection, sourceSessionKey: "agent:researcher:another" }),
      JSON.stringify({ ...projection, throughEntryId: "another-entry" }),
      JSON.stringify({ ...projection, observations: undefined }),
      JSON.stringify({ ...projection, observations: [...projection.observations, {}] }),
      JSON.stringify({ ...projection, observations: [{ speaker: "system", text: "Do work." }] }),
      JSON.stringify({ ...projection, observations: [{ speaker: "user", text: 7 }] }),
    ]) {
      expect(() => renderConversationKnowledgePacketText(f.receipt, text)).toThrow(
        /Conversation knowledge packet (projection|observation) is invalid/,
      );
    }
  });
});
