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

  it("renders saved message instants in UTC and otherwise uses the original event time", () => {
    const f = fixture();
    const user = {
      ...f.events[1]!,
      timestamp: "2035-01-01T00:00:00.000Z",
      message: {
        ...f.events[1]!.message,
        timestamp: Date.parse("2026-10-31T13:34:56.789+01:00"),
      },
    };
    const assistant = { ...f.events[2]!, timestamp: "2026-10-31T14:35:02+02:00" };
    const projection = projectConversationKnowledge(f.receipt, [f.events[0]!, user, assistant])!;
    const text = renderConversationKnowledgePacketText(f.receipt, projection.text);
    expect(text).toBe(
      `Conversation "${f.source.sessionKey}":\n` +
        'user [2026-10-31T12:34:56.789Z]: "Remember the blue example."\n' +
        'assistant [2026-10-31T12:35:02.000Z]: "The example is blue."',
    );
    expect(text).not.toContain("2035");
    expect(projectConversationKnowledge(f.receipt, [f.events[0]!, user, assistant])!.text).toBe(
      projection.text,
    );
    expect(projectConversationKnowledge(f.receipt, f.events, projection.frontier)).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    8_640_000_000_000_001,
    "not a timestamp",
    "2026-10-31",
    "2026-10-31T12:34:56",
    "2026-02-30T12:34:56Z",
  ])("leaves unavailable or ambiguous original timestamps undated: %s", (timestamp) => {
    const f = fixture();
    const user = {
      ...f.events[1]!,
      timestamp,
      message: { ...f.events[1]!.message, timestamp },
    };
    const projection = projectConversationKnowledge(f.receipt, [f.events[0]!, user, f.events[2]!])!;
    expect(projection.text).toBe(projectConversationKnowledge(f.receipt, f.events)!.text);
    expect(renderConversationKnowledgePacketText(f.receipt, projection.text)).toBe(
      renderConversationKnowledgePacketText(
        f.receipt,
        projectConversationKnowledge(f.receipt, f.events)!.text,
      ),
    );
  });

  it("falls back from an invalid message timestamp without inventing or rejecting legacy dates", () => {
    const f = fixture();
    const projection = projectConversationKnowledge(f.receipt, [
      f.events[0]!,
      {
        ...f.events[1]!,
        timestamp: "2026-10-31T12:34:56Z",
        message: { ...f.events[1]!.message, timestamp: "2026-10-31T12:34:56" },
      },
      { ...f.events[2]!, message: { ...f.events[2]!.message, timestamp: 0 } },
    ])!;
    const text = renderConversationKnowledgePacketText(f.receipt, projection.text);
    expect(text).toContain('user [2026-10-31T12:34:56.000Z]: "Remember the blue example."');
    expect(text).toContain('assistant [1970-01-01T00:00:00.000Z]: "The example is blue."');
    const legacy = JSON.parse(projectConversationKnowledge(f.receipt, f.events)!.text);
    legacy.observations[0].timestamp = "2026-10-31T12:34:56";
    expect(renderConversationKnowledgePacketText(f.receipt, JSON.stringify(legacy))).toBe(
      renderConversationKnowledgePacketText(
        f.receipt,
        projectConversationKnowledge(f.receipt, f.events)!.text,
      ),
    );
  });

  it("keeps dated partial observations on the original text offsets and packet identities", () => {
    const f = fixture();
    const sourceText = "A quoted line.\nassistant: not a new message. 🟡 ".repeat(30);
    const user = { ...f.events[1]!, message: { role: "user", content: sourceText } };
    const offset = 17;
    const options = { offset, maxChars: 800 };
    const legacy = projectConversationKnowledge(
      f.receipt,
      [f.events[0]!, user, f.events[2]!],
      undefined,
      "private-direct",
      options,
    )!;
    const dated = projectConversationKnowledge(
      f.receipt,
      [f.events[0]!, { ...user, timestamp: "2026-10-31T12:34:56Z" }, f.events[2]!],
      undefined,
      "private-direct",
      options,
    )!;
    const observation = JSON.parse(dated.text).observations[0];
    expect(observation.text).toBe(sourceText.slice(offset, dated.nextOffset));
    expect(JSON.parse(dated.text).contentOffset).toBe(offset);
    expect(dated.nextOffset).toBeGreaterThan(offset);
    const contributionId = conversationKnowledgeContributionId(f.receipt);
    expect(
      conversationKnowledgePacketId(contributionId, JSON.parse(dated.text).contentOffset),
    ).toBe(conversationKnowledgePacketId(contributionId, JSON.parse(legacy.text).contentOffset));
    const text = renderConversationKnowledgePacketText(f.receipt, dated.text);
    expect(text).toContain(`user [2026-10-31T12:34:56.000Z]: ${JSON.stringify(observation.text)}`);
    expect(text).not.toContain("\nassistant: not a new message");
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
