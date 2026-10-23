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

describe("private conversation contribution evidence", () => {
  it("keeps occurrence identity while decoding only same-interval native read continuity", () => {
    const f = privateFixture();
    const readRange = {
      through: { ...f.receipt.through, generation: "renewed" },
      admission: { ...f.receipt.privateAudience!.admission, generation: "renewed" },
    };
    const renewed = readConversationKnowledgeReceipt({ ...f.receipt, readRange });
    expect(renewed).toEqual({ ...f.receipt, readRange });
    expect(renewed?.through).toEqual(f.receipt.through);
    expect(projectConversationKnowledge(renewed!, f.events)?.text).toBe(
      projectConversationKnowledge(f.receipt, f.events)?.text,
    );
    for (const patch of [
      { entryId: "different" },
      { rawSeq: 9 },
      { effectiveParentId: null },
      { activeMessagePosition: 9 },
      { storePath: "/synthetic/another.sqlite" },
      { sessionId: "different" },
      { sessionKey: "agent:researcher:another" },
      { agentId: "another" },
      { generation: "" },
    ]) {
      expect(
        readConversationKnowledgeReceipt({
          ...f.receipt,
          readRange: { ...readRange, through: { ...readRange.through, ...patch } },
        }),
      ).toBeUndefined();
    }
    for (const admission of [
      undefined,
      { ...readRange.admission, generation: "unpaired" },
      { ...readRange.admission, rawSeq: 0 },
    ]) {
      expect(
        readConversationKnowledgeReceipt({ ...f.receipt, readRange: { ...readRange, admission } }),
      ).toBeUndefined();
    }
  });

  it("uses the canonical identity decoder without deriving aliases or accepting observation identities", () => {
    const f = privateFixture();
    expect(readConversationKnowledgeReceipt(f.receipt)).toEqual(f.receipt);
    const privateAudience = f.receipt.privateAudience!;
    const participant = {
      type: "remote",
      pluginId: "example-channel",
      domain: "Example.invalid",
      idKind: "user",
      id: " Person@Example.invalid ",
    };
    expect(
      readConversationKnowledgeReceipt({
        ...f.receipt,
        privateAudience: { ...privateAudience, participant },
      })?.privateAudience?.participant,
    ).toEqual(participant);
    for (const invalid of [
      { type: "profile", id: "" },
      { type: "profile", id: "person-alpha", senderId: "person-alpha" },
      { ...participant, id: undefined, senderId: participant.id },
      { type: "agent", id: "person-alpha" },
      {
        type: "observation",
        pluginId: "example-channel",
        accountId: "account-alpha",
        senderKind: "human",
        id: "person-alpha",
      },
    ]) {
      expect(
        readConversationKnowledgeReceipt({
          ...f.receipt,
          privateAudience: { ...privateAudience, participant: invalid },
        }),
      ).toBeUndefined();
    }
  });

  it("binds the admission to the identical source and generation before the terminal", () => {
    const f = privateFixture();
    const privateAudience = f.receipt.privateAudience!;
    for (const patch of [
      { agentId: "other-agent" },
      { sessionKey: "agent:researcher:example:other" },
      { sessionId: "other-session" },
      { storePath: "/synthetic/other.sqlite" },
      { generation: "replacement-generation" },
      { rawSeq: f.receipt.through.rawSeq + 1 },
      { rawSeq: f.receipt.through.rawSeq },
      { rawSeq: -1 },
      { activeMessagePosition: -1 },
      { effectiveParentId: undefined },
    ]) {
      expect(
        readConversationKnowledgeReceipt({
          ...f.receipt,
          privateAudience: {
            ...privateAudience,
            admission: { ...privateAudience.admission, ...patch },
          },
        }),
      ).toBeUndefined();
    }
  });

  it("projects a proven private exchange but never widens its backwards-discovered input batch", () => {
    const f = privateFixture();
    expect(isCompletedConversationKnowledge(f.receipt, f.events)).toBe(true);
    expect(projectConversationKnowledge(f.receipt, f.events)?.text).toContain("blue example");
    const sharedPrefix = [
      f.events[0]!,
      {
        type: "message",
        id: "shared-question",
        message: { role: "user", content: "Shared secret." },
      },
      ...f.events.slice(1),
    ];
    expect(isCompletedConversationKnowledge(f.receipt, sharedPrefix)).toBe(false);
    expect(projectConversationKnowledge(f.receipt, sharedPrefix)).toBeUndefined();
    // Old receipts retain the existing contiguous-input semantics, not a new channel grant.
    expect(projectConversationKnowledge(fixture().receipt, sharedPrefix)?.text).toContain(
      "Shared secret.",
    );
  });

  it("refuses a missing or later admission even when a completed replacement input survives compaction", () => {
    const f = privateFixture();
    const compacted = [f.events[0]!, { ...f.events[1]!, id: "replacement-question" }, f.events[2]!];
    expect(isCompletedConversationKnowledge(f.receipt, compacted)).toBe(false);
    expect(projectConversationKnowledge(f.receipt, compacted)).toBeUndefined();
    const late = {
      ...f.receipt,
      privateAudience: {
        ...f.receipt.privateAudience!,
        admission: f.receipt.through,
      },
    };
    expect(isCompletedConversationKnowledge(late, f.events)).toBe(false);
    expect(projectConversationKnowledge(late, f.events)).toBeUndefined();
  });
});

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
      selectConversationKnowledgeReport({ ...f.receipt, sourceMode: "native" }, previous),
    ).toBeUndefined();
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

  it.each([undefined, null, "", "Native", " branches", "other"])(
    "rejects missing or invalid source mode %j instead of guessing a legacy mode",
    (sourceMode) => {
      const f = fixture();
      expect(readConversationKnowledgeReceipt({ ...f.receipt, sourceMode })).toBeUndefined();
      expect(
        readConversationUtteranceObservation({
          ...f.receipt,
          runId: undefined,
          origin: conversationKnowledgeOrigin(f.source, "utterance-observation"),
          kind: "utterance-observation",
          role: "assistant",
          sourceMode,
        }),
      ).toBeUndefined();
    },
  );

  it("keeps native consumption limited to branch-origin receipts without changing order or endpoint identity", () => {
    const branch = fixture("branch").receipt;
    const native: ConversationKnowledgeReceipt = {
      ...fixture("native").receipt,
      sourceMode: "native",
    };
    const nextBranch = {
      ...branch,
      through: { ...branch.through, entryId: "later-branch-answer", rawSeq: 8 },
    };
    const relabeled: ConversationKnowledgeReceipt = { ...native, sourceMode: "branches" };
    const events = [branch, native, nextBranch, relabeled].map((details) => ({
      type: "custom_message",
      customType: CONVERSATION_KNOWLEDGE_REPORT,
      details,
    }));
    expect(selectConversationKnowledgeReceipts(events, "recipient")).toEqual([
      branch,
      native,
      nextBranch,
    ]);
    expect(selectConversationKnowledgeReceipts(events, "recipient", undefined, "native")).toEqual([
      branch,
      nextBranch,
    ]);
    expect(readConversationKnowledgeReceipt(native)?.sourceMode).toBe("native");
    const nativeProjection = projectConversationKnowledge(
      { ...fixture().receipt, sourceMode: "native" },
      fixture().events,
    );
    expect(JSON.parse(nativeProjection?.text ?? "{}").sourceMode).toBe("native");
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

  it("omits routed input carriers without suppressing genuine repeated dialogue", () => {
    const f = fixture();
    const events = [
      f.events[0]!,
      f.events[1]!,
      {
        type: "message",
        id: "external-repeat",
        message: {
          role: "user",
          content: "Remember the blue example.",
          provenance: { kind: "external_user" },
        },
      },
      ...["inter_session", "internal_system"].map((kind) => ({
        type: "message",
        id: `routed-${kind}`,
        message: {
          role: "user",
          content: `Forwarded ${kind} payload.`,
          provenance: { kind, sourceTool: "sessions_send" },
        },
      })),
      {
        type: "custom_message",
        id: "retained-packet",
        customType: "openclaw.conversation-knowledge-context.v1",
        content: "Previously imported knowledge must not become new dialogue.",
      },
      {
        ...f.events[2]!,
        id: "assistant-repeat",
      },
      f.events[2]!,
    ];
    const part = projectConversationKnowledge(f.receipt, events);
    expect(part?.complete).toBe(true);
    const data = JSON.parse(part?.text ?? "{}");
    expect(data.routedInputsOmitted).toBe(true);
    expect(data.observations).toEqual([
      { speaker: "user", text: "Remember the blue example." },
      { speaker: "user", text: "Remember the blue example." },
      { speaker: "assistant", text: "The example is blue." },
      { speaker: "assistant", text: "The example is blue." },
    ]);
    expect(part?.text).not.toContain("Forwarded");
    expect(part?.text).not.toContain("Previously imported");
  });

  it("preserves legacy partial offsets while skipping large routed input carriers", () => {
    const f = fixture();
    const forwarded = "Previously forwarded conversation data. ".repeat(1_000);
    const events = [
      f.events[0]!,
      f.events[1]!,
      {
        type: "message",
        id: "forwarded-input",
        message: {
          role: "user",
          content: forwarded,
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
      },
      f.events[2]!,
    ];
    // Before routed-carrier filtering, a persisted offset could land inside
    // this payload. Its coordinate must not shift to a later real observation.
    const oldOffset = "Remember the blue example.".length + 5_000;
    const resumed = projectConversationKnowledge(f.receipt, events, undefined, "unknown", {
      offset: oldOffset,
      maxChars: 800,
    });
    expect(resumed?.complete).toBe(true);
    expect(resumed?.frontier?.throughEntryId).toBe(f.receipt.through.entryId);
    expect(JSON.parse(resumed?.text ?? "{}").contentOffset).toBe(oldOffset);
    expect(JSON.parse(resumed?.text ?? "{}").observations).toEqual([
      { speaker: "assistant", text: "The example is blue." },
    ]);
  });

  it("selects only data newer than the exact accepted frontier and suppresses replay", () => {
    const f = fixture();
    const first = projectConversationKnowledge(f.receipt, f.events);
    if (!first?.frontier) {
      throw new Error("Synthetic completed observation missing");
    }
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

  it("keeps packets bounded without acknowledging undelivered text", () => {
    const f = fixture();
    f.events[1] = {
      type: "message",
      id: "question",
      message: { role: "user", content: "x".repeat(10_000) },
    };
    const projected = projectConversationKnowledge(f.receipt, f.events);
    expect(projected?.text.length).toBeLessThanOrEqual(4_000);
    expect(projected?.complete).toBe(false);
    expect(projected?.frontier).toBeUndefined();
    const data = JSON.parse(projected?.text ?? "{}");
    expect(data.contentTruncated).toBe(true);
    expect(data.sourceSessionKey).toBe(f.source.sessionKey);
    expect(data.throughEntryId).toBe("answer");
    expect(data.observations[0].speaker).toBe("user");
    expect(data.sourceAudience).toBe("unknown");
    expect(data.sourceMode).toBe("branches");
    expect(data.speakerIdentity).toBe("not-attributed-to-the-current-user");
    expect(projected).not.toHaveProperty("role");
    let offset = 0;
    let text = "";
    for (let packet = 0; packet < 64; packet += 1) {
      const part = projectConversationKnowledge(f.receipt, f.events, undefined, "unknown", {
        maxChars: 1_000,
        offset,
      });
      if (!part) {
        throw new Error("Synthetic pending packet missing");
      }
      const observations: Array<{ text: string }> = JSON.parse(part.text).observations;
      text += observations.map((observation) => observation.text).join("");
      expect(part.text.length).toBeLessThanOrEqual(1_000);
      if (part.complete) {
        expect(part.frontier?.throughEntryId).toBe("answer");
        expect(text).toBe("x".repeat(10_000) + "The example is blue.");
        return;
      }
      expect(part.frontier).toBeUndefined();
      expect(part.nextOffset).toBeGreaterThan(offset);
      offset = part.nextOffset!;
    }
    throw new Error("Synthetic contribution did not finish within its expected packet count");
  });

  it("retains distinct completions from one source in chronological order without duplicates", () => {
    const f = fixture();
    const next = {
      ...f.receipt,
      runId: "run-next",
      through: { ...f.receipt.through, rawSeq: 7, entryId: "answer-next" },
    };
    const events = [f.receipt, next, f.receipt, next].map((details) => ({
      type: "custom_message",
      customType: CONVERSATION_KNOWLEDGE_REPORT,
      details,
    }));
    expect(selectConversationKnowledgeReceipts(events, "other")).toEqual([f.receipt, next]);
    const observed = Array.from({ length: 7 }, (_, index) => ({
      origin: fixture(String(index)).receipt.origin,
      generation: "original",
      throughRawSeq: index,
      throughEntryId: `entry-${index}`,
    }));
    expect(readConversationKnowledgeReceipt({ ...f.receipt, observed })?.observed).toEqual(
      observed,
    );
    expect(
      combineConversationKnowledge([
        {
          text: "Earlier observed exchange.",
          frontier: {
            origin: f.receipt.origin,
            generation: "original",
            throughRawSeq: 2,
            throughEntryId: "earlier",
          },
        },
        {
          text: "Later observed exchange.",
          frontier: {
            origin: f.receipt.origin,
            generation: "original",
            throughRawSeq: 4,
            throughEntryId: "later",
          },
        },
      ]).frontiers,
    ).toEqual([
      {
        origin: f.receipt.origin,
        generation: "original",
        throughRawSeq: 4,
        throughEntryId: "later",
      },
    ]);
  });

  it("quotes every completed row rather than selecting the final four", () => {
    const f = fixture();
    const middle = Array.from({ length: 5 }, (_, index) => ({
      type: "message",
      id: `commentary-${index}`,
      message: {
        role: "assistant",
        content: `Observation ${index}.`,
        __openclaw: { runId: f.receipt.runId },
      },
    }));
    const part = projectConversationKnowledge(f.receipt, [
      f.events[0]!,
      f.events[1]!,
      ...middle,
      f.events[2]!,
    ]);
    expect(part?.complete).toBe(true);
    expect(JSON.parse(part?.text ?? "{}").observations).toHaveLength(7);
    expect(part?.text).toContain("Observation 0.");
    const collected = projectConversationKnowledge(f.receipt, [
      f.events[0]!,
      {
        type: "message",
        id: "collected-first",
        message: { role: "user", content: "First collected request." },
      },
      f.events[1]!,
      f.events[2]!,
    ]);
    expect(collected?.text).toContain("First collected request.");
    expect(JSON.parse(collected?.text ?? "{}").observations).toHaveLength(3);
  });

  it("keeps partial and excluded packets pending without granting their completion frontier", () => {
    const f = fixture();
    const full = projectConversationKnowledge(f.receipt, f.events);
    if (!full?.frontier) {
      throw new Error("Synthetic full contribution missing");
    }
    const combined = combineConversationKnowledge([
      full,
      { text: "partial", complete: false },
      { text: "x".repeat(12_000), frontier: full.frontier },
    ]);
    expect(combined.pending).toBe(true);
    expect(combined.text).toContain("partial");
    expect(combined.frontiers).toEqual([full.frontier]);
    expect(combined.text.length).toBeLessThanOrEqual(12_000);
    expect(
      projectConversationKnowledge(f.receipt, f.events, undefined, "unknown", { offset: -1 }),
    ).toBeUndefined();
    expect(
      projectConversationKnowledge(f.receipt, f.events, undefined, "unknown", { maxChars: 1 }),
    ).toBeUndefined();
  });

  it("resumes escaped and Unicode text without splitting surrogate pairs or acknowledging a prefix", () => {
    const f = fixture();
    const original = '🦊"\\\n'.repeat(200);
    f.events[1] = {
      type: "message",
      id: "question",
      message: { role: "user", content: original },
    };
    let offset = 0;
    let reconstructed = "";
    for (let packet = 0; packet < 64; packet += 1) {
      const part = projectConversationKnowledge(f.receipt, f.events, undefined, "unknown", {
        offset,
        maxChars: 700,
      });
      if (!part) {
        throw new Error("Synthetic Unicode packet missing");
      }
      const observations: Array<{ text: string }> = JSON.parse(part.text).observations;
      const chunk = observations.map((row) => row.text).join("");
      expect(chunk.isWellFormed()).toBe(true);
      expect(part.text.length).toBeLessThanOrEqual(700);
      reconstructed += chunk;
      if (part.complete) {
        expect(reconstructed).toBe(original + "The example is blue.");
        return;
      }
      expect(part.frontier).toBeUndefined();
      offset = part.nextOffset!;
    }
    throw new Error("Synthetic Unicode contribution did not finish");
  });

  it("rebases only an admitted replacement generation without reusing the old sequence", () => {
    const f = fixture();
    const frontier = projectConversationKnowledge(f.receipt, f.events)?.frontier;
    if (!frontier) {
      throw new Error("Synthetic frontier missing");
    }
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
      f.receipt,
      replacement,
    ]);
    expect(
      selectConversationKnowledgeReceipts(events, "other-current-session", f.source.sessionKey),
    ).toEqual([]);
  });

  it("keeps all eligible sources and excludes this branch rather than assuming ancestry is permission", () => {
    const receipts = Array.from({ length: 8 }, (_, index) => fixture(String(index)).receipt);
    const events = receipts.map((receipt) => ({
      type: "custom_message",
      customType: CONVERSATION_KNOWLEDGE_REPORT,
      details: receipt,
    }));
    const selected = selectConversationKnowledgeReceipts(events, receipts[7]!.source.sessionId);
    expect(selected).toHaveLength(7);
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

  it("excludes superseded incarnations of one logical branch", () => {
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
    expect(
      selectConversationKnowledgeReceipts(
        [events[0]!, { ...events[1]!, details: { ...replacement, sourceMode: "native" } }],
        "other-current-session",
        undefined,
        "native",
      ),
    ).toEqual([]);
  });
});

describe("committed native realtime utterance observations", () => {
  function utteranceFixture() {
    const f = fixture();
    const receipt: ConversationUtteranceObservation = {
      version: 1,
      sourceMode: "branches",
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
    expect(data.observations).toEqual([{ speaker: "assistant", text: "A spoken answer." }]);
    expect(projectConversationKnowledge(f.receipt, events, part?.frontier)).toBeUndefined();
  });

  it("projects each committed utterance reference exactly once rather than replaying its prefix", () => {
    const f = utteranceFixture();
    const first = {
      ...f.receipt,
      role: "user" as const,
      through: { ...f.receipt.through, entryId: "question", rawSeq: 1 },
    };
    const user = JSON.parse(projectConversationKnowledge(first, f.events)?.text ?? "{}");
    const assistant = JSON.parse(projectConversationKnowledge(f.receipt, f.events)?.text ?? "{}");
    expect(user.observations).toEqual([{ speaker: "user", text: "A spoken question." }]);
    expect(assistant.observations).toEqual([{ speaker: "assistant", text: "A spoken answer." }]);
  });

  it("allows the exact private voice anchor and refuses missing lower admission evidence", () => {
    const f = utteranceFixture();
    const receipt: ConversationUtteranceObservation = {
      ...f.receipt,
      privateAudience: {
        participant: { type: "profile", id: "person-alpha" },
        admission: f.receipt.through,
      },
    };
    expect(readConversationUtteranceObservation(receipt)).toEqual(receipt);
    expect(isConversationUtteranceObservation(receipt, f.events)).toBe(true);
    expect(projectConversationKnowledge(receipt, f.events)?.text).toContain("spoken answer");
    const missing = {
      ...receipt,
      privateAudience: {
        ...receipt.privateAudience!,
        admission: { ...receipt.through, entryId: "removed-admission", rawSeq: 1 },
      },
    };
    expect(isConversationUtteranceObservation(missing, f.events)).toBe(false);
    expect(projectConversationKnowledge(missing, f.events)).toBeUndefined();
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
    const nativeUtterance: ConversationUtteranceObservation = {
      ...f.receipt,
      sourceMode: "native",
    };
    const nativeEvents = [events[0]!, { ...events[1]!, details: nativeUtterance }];
    expect(selectConversationKnowledgeReceipts(nativeEvents, "other", undefined, "native")).toEqual(
      [complete],
    );
    expect(selectConversationKnowledgeReceipts(nativeEvents, "other")).toEqual([
      complete,
      nativeUtterance,
    ]);
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
