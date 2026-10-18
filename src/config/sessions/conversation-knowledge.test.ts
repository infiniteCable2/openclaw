import { describe, expect, it } from "vitest";
import {
  combineConversationKnowledge,
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
  conversationKnowledgeOrigin,
  isCompletedConversationKnowledge,
  projectConversationKnowledge,
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
  isConversationUtteranceObservation,
  selectConversationKnowledgeReceipts,
  selectConversationKnowledgeReport,
  type ConversationKnowledgeReceipt,
  type ConversationUtteranceObservation,
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

describe("native conversation knowledge references and bounded data", () => {
  it("keeps root consolidation text-free and validates its original source incarnation", () => {
    const f = fixture();
    const report = selectConversationKnowledgeReport(f.receipt, undefined);
    expect(report?.details).toEqual(f.receipt);
    expect(report?.content).not.toContain("blue");
    expect(report?.display).toBe(false);
    expect(readConversationKnowledgeReceipt(f.receipt)).toEqual(f.receipt);
    expect(
      readConversationKnowledgeReceipt({
        ...f.receipt,
        source: { ...f.source, lifecycleRevision: "replacement" },
      }),
    ).toBeUndefined();
    expect(
      readConversationKnowledgeReceipt({
        ...f.receipt,
        through: { ...f.receipt.through, sessionId: "replacement" },
      }),
    ).toBeUndefined();
  });

  it("deduplicates a source endpoint without confusing a sibling's receipt", () => {
    const f = fixture();
    const previous = selectConversationKnowledgeReport(f.receipt, undefined);
    expect(selectConversationKnowledgeReport(f.receipt, previous)).toBeUndefined();
    expect(
      selectConversationKnowledgeReport(
        { ...f.receipt, through: { ...f.receipt.through, rawSeq: 3 } },
        previous,
      ),
    ).toBeUndefined();
    expect(
      selectConversationKnowledgeReport(
        { ...f.receipt, through: { ...f.receipt.through, rawSeq: 5 } },
        previous,
      ),
    ).toBeDefined();
    expect(selectConversationKnowledgeReport(fixture("beta").receipt, previous)).toBeDefined();
    // Native source predicates, not receipt ordering, validate a post-compaction generation.
    expect(
      selectConversationKnowledgeReport(
        {
          ...f.receipt,
          through: { ...f.receipt.through, generation: "replacement-generation", rawSeq: 1 },
        },
        previous,
      ),
    ).toBeDefined();
  });

  it("does not project a running suffix, wrong run, failed reply, or missing terminal", () => {
    const f = fixture();
    expect(isCompletedConversationKnowledge(f.receipt, f.events)).toBe(true);
    expect(
      projectConversationKnowledge(f.receipt, [
        ...f.events,
        {
          type: "message",
          id: "pending",
          message: { role: "user", content: "This is not completed yet." },
        },
      ])?.text,
    ).not.toContain("not completed");
    expect(isCompletedConversationKnowledge({ ...f.receipt, runId: "unrelated" }, f.events)).toBe(
      false,
    );
    expect(
      isCompletedConversationKnowledge(
        { ...f.receipt, through: { ...f.receipt.through, entryId: "missing" } },
        f.events,
      ),
    ).toBe(false);
    const failed = f.events.map((event) =>
      event.id === "answer"
        ? { ...event, message: { ...event.message, stopReason: "error" } }
        : event,
    );
    expect(isCompletedConversationKnowledge(f.receipt, failed)).toBe(false);
  });

  it("requires completed native tool pairs and never copies tool payloads", () => {
    const f = fixture();
    const tool = {
      type: "message",
      id: "call",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-alpha",
            name: "exec",
            arguments: { command: "sensitive payload" },
          },
        ],
        stopReason: "toolUse",
      },
    };
    expect(
      projectConversationKnowledge(f.receipt, [f.events[0], f.events[1], tool, f.events[2]]),
    ).toBeUndefined();
    const result = {
      type: "message",
      id: "result",
      message: {
        role: "toolResult",
        toolCallId: "call-alpha",
        toolName: "exec",
        isError: false,
        content: [{ type: "text", text: "sensitive result" }],
      },
    };
    const projected = projectConversationKnowledge(f.receipt, [
      f.events[0],
      f.events[1],
      tool,
      result,
      f.events[2],
    ]);
    expect(projected?.text).toContain("example is blue");
    expect(projected?.text).not.toContain("sensitive");
  });

  it("selects only data newer than the exact accepted frontier and suppresses replay", () => {
    const f = fixture();
    const first = projectConversationKnowledge(f.receipt, f.events);
    if (!first) throw new Error("Synthetic completed observation missing");
    expect(projectConversationKnowledge(f.receipt, f.events, first.frontier)).toBeUndefined();
    const next = {
      ...f.receipt,
      runId: "run-next",
      through: { ...f.receipt.through, entryId: "answer-next", rawSeq: 7 },
    };
    const events = [
      ...f.events,
      {
        type: "message",
        id: "question-next",
        message: { role: "user", content: "Now the example is green." },
      },
      {
        type: "message",
        id: "answer-next",
        message: {
          role: "assistant",
          content: "It is green now.",
          stopReason: "stop",
          __openclaw: { runId: "run-next" },
        },
      },
    ];
    const delta = projectConversationKnowledge(next, events, first.frontier);
    expect(delta?.text).toContain("green");
    expect(delta?.text).not.toContain("blue");
    expect(
      projectConversationKnowledge(next, events, {
        ...first.frontier,
        throughEntryId: "removed-frontier",
      }),
    ).toBeUndefined();
  });

  it("does not poison a new completed turn with an older aborted run", () => {
    const f = fixture();
    const earlier = [
      { type: "message", id: "old-user", message: { role: "user", content: "Earlier request." } },
      {
        type: "message",
        id: "old-aborted",
        message: {
          role: "assistant",
          content: "Interrupted old answer.",
          stopReason: "aborted",
          __openclaw: { runId: "old-aborted-run" },
        },
      },
    ];
    const events = [...earlier, ...f.events];
    expect(isCompletedConversationKnowledge(f.receipt, events)).toBe(true);
    const projected = projectConversationKnowledge(f.receipt, events);
    expect(projected?.text).not.toContain("Interrupted old answer");
    expect(projected?.text).not.toContain("Earlier request");
    expect(JSON.parse(projected?.text ?? "{}").contentTruncated).toBe(true);
  });

  it("keeps quoting bounded and explicitly exposes truncation plus the native readable reference", () => {
    const f = fixture();
    f.events[1] = {
      type: "message",
      id: "question",
      message: { role: "user", content: "x".repeat(10_000) },
    };
    const projected = projectConversationKnowledge(f.receipt, f.events);
    expect(projected?.text.length).toBeLessThan(4_000);
    const data = JSON.parse(projected?.text ?? "{}");
    expect(data.contentTruncated).toBe(true);
    expect(data.sourceSessionKey).toBe(f.source.sessionKey);
    expect(data.throughEntryId).toBe("answer");
    expect(data.observations[0].speaker).toBe("user");
    expect(data.sourceAudience).toBe("unknown");
    expect(data.speakerIdentity).toBe("not-attributed-to-the-current-user");
    expect(projected).not.toHaveProperty("role");
  });

  it("rebases only an admitted replacement generation without reusing the old sequence", () => {
    const f = fixture();
    const frontier = projectConversationKnowledge(f.receipt, f.events)?.frontier;
    if (!frontier) throw new Error("Synthetic frontier missing");
    const replacement = {
      ...f.receipt,
      through: { ...f.receipt.through, generation: "replacement-generation", rawSeq: 1 },
    };
    const replacementData = projectConversationKnowledge(replacement, f.events, frontier, "shared");
    expect(JSON.parse(replacementData?.text ?? "{}")).toMatchObject({
      frontierRebased: true,
      sourceAudience: "shared",
      speakerIdentity: "not-attributed-to-the-current-user",
    });
    const events = [f.receipt, replacement].map((details) => ({
      type: "custom_message",
      customType: CONVERSATION_KNOWLEDGE_REPORT,
      details,
    }));
    expect(selectConversationKnowledgeReceipts(events, "other-current-session")).toEqual([
      replacement,
    ]);
    expect(
      selectConversationKnowledgeReceipts(events, "other-current-session", f.source.sessionKey),
    ).toEqual([]);
  });

  it("keeps root selection bounded and excludes this branch rather than assuming ancestry is permission", () => {
    const receipts = Array.from({ length: 8 }, (_, index) => fixture(String(index)).receipt);
    const events = receipts.map((receipt) => ({
      type: "custom_message",
      customType: CONVERSATION_KNOWLEDGE_REPORT,
      details: receipt,
    }));
    const selected = selectConversationKnowledgeReceipts(events, receipts[7]!.source.sessionId);
    expect(selected).toHaveLength(4);
    expect(
      selected.some((receipt) => receipt.source.sessionId === receipts[7]!.source.sessionId),
    ).toBe(false);
    expect(
      combineConversationKnowledge(
        selected.map((receipt) => ({
          text: "x".repeat(4_000),
          frontier: {
            origin: receipt.origin,
            generation: receipt.through.generation,
            throughRawSeq: receipt.through.rawSeq,
            throughEntryId: receipt.through.entryId,
          },
        })),
      ).text.length,
    ).toBeLessThan(12_010);
  });

  it("does not spend the source budget on superseded incarnations of one logical branch", () => {
    const f = fixture();
    const nextSource = {
      ...f.source,
      sessionId: "session-replacement",
      lifecycleRevision: "replacement",
    };
    const replacement: ConversationKnowledgeReceipt = {
      ...f.receipt,
      source: nextSource,
      origin: conversationKnowledgeOrigin(nextSource),
      through: { ...f.receipt.through, sessionId: nextSource.sessionId },
    };
    const events = [f.receipt, replacement].map((details) => ({
      type: "custom_message",
      customType: CONVERSATION_KNOWLEDGE_REPORT,
      details,
    }));
    expect(selectConversationKnowledgeReceipts(events, "other-current-session")).toEqual([
      replacement,
    ]);
  });
});

describe("committed native realtime utterance observations", () => {
  function utteranceFixture() {
    const f = fixture();
    const receipt: ConversationUtteranceObservation = {
      version: 1,
      source: f.source,
      origin: conversationKnowledgeOrigin(f.source, "utterance-observation"),
      kind: "utterance-observation",
      role: "assistant",
      through: f.receipt.through,
    };
    const provenance = { kind: "realtime_voice", sourceChannel: "talk" };
    const events = [
      {
        type: "message",
        id: "question",
        message: { role: "user", content: "A spoken question.", provenance },
      },
      {
        type: "message",
        id: "answer",
        message: {
          role: "assistant",
          content: "A spoken answer.",
          provenance,
          api: "realtime",
          stopReason: "stop",
        },
      },
    ];
    return { ...f, receipt, events };
  }

  it("has an independent reference/frontier namespace and never masquerades as a completed run", () => {
    const f = utteranceFixture();
    expect(readConversationUtteranceObservation(f.receipt)).toEqual(f.receipt);
    expect(readConversationKnowledgeReceipt(f.receipt)).toBeUndefined();
    expect(
      readConversationUtteranceObservation({ ...f.receipt, runId: "invented" }),
    ).toBeUndefined();
    expect(f.receipt.origin).not.toBe(conversationKnowledgeOrigin(f.source));
    const report = selectConversationKnowledgeReport(f.receipt, undefined);
    expect(report?.customType).toBe(CONVERSATION_UTTERANCE_REPORT);
    expect(report?.content).not.toContain("spoken");
    expect(report?.details).not.toHaveProperty("runId");
    expect(selectConversationKnowledgeReport(f.receipt, report)).toBeUndefined();
  });

  it("quotes actual realtime dialogue without implying completed work or adjacent task text", () => {
    const f = utteranceFixture();
    const events = [
      f.events[0]!,
      {
        type: "message",
        id: "task",
        message: {
          role: "assistant",
          content: "Do not replay this tool task.",
          stopReason: "toolUse",
          __openclaw: { runId: "task-run" },
        },
      },
      f.events[1]!,
    ];
    const part = projectConversationKnowledge(f.receipt, events);
    const data = JSON.parse(part?.text ?? "{}");
    expect(data).toMatchObject({ kind: "utterance-observation", taskCompletion: "not-implied" });
    expect(data).not.toHaveProperty("completedRun");
    expect(data.observations).toEqual([
      { speaker: "user", text: "A spoken question." },
      { speaker: "assistant", text: "A spoken answer." },
    ]);
    expect(projectConversationKnowledge(f.receipt, events, part?.frontier)).toBeUndefined();
  });

  it("refuses role/provenance/run mismatches and tool-bearing voice-looking data", () => {
    const f = utteranceFixture();
    expect(isConversationUtteranceObservation(f.receipt, f.events)).toBe(true);
    expect(isConversationUtteranceObservation({ ...f.receipt, role: "user" }, f.events)).toBe(
      false,
    );
    for (const patch of [
      { provenance: { kind: "other", sourceChannel: "talk" } },
      { api: "other" },
      { stopReason: "aborted" },
      { __openclaw: { runId: "task-run" } },
      { content: [{ type: "toolCall", id: "call", name: "exec", arguments: {} }] },
    ]) {
      const events = [
        f.events[0]!,
        { ...f.events[1]!, message: { ...f.events[1]!.message, ...patch } },
      ];
      expect(projectConversationKnowledge(f.receipt, events)).toBeUndefined();
    }
  });

  it("selects utterance and completed references independently for the same source", () => {
    const f = utteranceFixture();
    const complete = fixture().receipt;
    const events = [
      { type: "custom_message", customType: CONVERSATION_KNOWLEDGE_REPORT, details: complete },
      { type: "custom_message", customType: CONVERSATION_UTTERANCE_REPORT, details: f.receipt },
    ];
    expect(selectConversationKnowledgeReceipts(events, "other")).toEqual([complete, f.receipt]);
    expect(selectConversationKnowledgeReceipts(events, f.source.sessionId)).toEqual([]);
    const nextSource = {
      ...f.source,
      sessionId: "replacement-session",
      lifecycleRevision: "replacement",
    };
    const replacement: ConversationUtteranceObservation = {
      ...f.receipt,
      source: nextSource,
      origin: conversationKnowledgeOrigin(nextSource, "utterance-observation"),
      through: { ...f.receipt.through, sessionId: nextSource.sessionId },
    };
    expect(
      selectConversationKnowledgeReceipts(
        [
          ...events,
          {
            type: "custom_message",
            customType: CONVERSATION_UTTERANCE_REPORT,
            details: replacement,
          },
        ],
        "other",
      ),
    ).toEqual([replacement]);
  });
});
