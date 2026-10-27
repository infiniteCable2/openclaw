import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  persistSessionTranscriptTurn,
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
} from "./session-accessor.js";
import {
  readSessionTranscriptBoundedActiveContextCore,
  readSessionTranscriptBoundedActiveContextUsageCore,
} from "./session-accessor.sqlite-active-context.js";
import {
  readRecentSessionTranscriptActiveEvents,
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptBoundedMessageTailPage,
} from "./session-accessor.sqlite-active-events.js";
import {
  countAcquiredTranscriptPayloadBytes,
  withBoundedContextScope,
} from "./session-accessor.sqlite-bounded-context.test-support.js";
import {
  readActiveTranscriptStats,
  readSessionTranscriptHistoryEventById,
  withRecentActiveTranscriptEvents,
} from "./session-accessor.sqlite-history.test-support.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

const readSessionTranscriptMessageEventCount = (
  scope: Parameters<typeof readSessionTranscriptMessageEventPage>[0],
): number =>
  readSessionTranscriptMessageEventPage(scope, { maxMessages: 0, offset: 0 }).totalMessages;

it("reports active model-context omission without treating a retained complete view as truncated", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("large", null, { role: "user", content: "a".repeat(2_048) }),
        transcriptMessage("middle", "large", { role: "user", content: "Middle message." }),
        transcriptMessage("last", "middle", { role: "user", content: "Last message." }),
      ],
      touchSessionEntry: false,
    });
    expect(readSessionTranscriptModelContext(scope).truncated).toBeUndefined();
    expect(
      readSessionTranscriptModelContext(scope, undefined, { maxBytes: 16_384, maxEvents: 3 })
        .truncated,
    ).toBeUndefined();
    expect(
      readSessionTranscriptModelContext(scope, undefined, { maxBytes: 16_384, maxEvents: 2 })
        .truncated,
    ).toBe(true);
    expect(
      readSessionTranscriptModelContext(scope, undefined, { maxBytes: 1_024, maxEvents: 3 })
        .truncated,
    ).toBe(true);
  });
});

it("selects an inclusive contribution range before acquiring older or later payloads", async () => {
  await withBoundedContextScope(async (scope) => {
    const marker = "synthetic-outside-contribution:";
    await appendTranscriptMessage(scope, {
      eventId: "old-conversation",
      message: { role: "user", content: marker + "x".repeat(16_000), timestamp: 1 },
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "older-summary",
      parentId: "old-conversation",
      firstKeptEntryId: "old-conversation",
      summary: marker + "old summary",
      tokensBefore: 100,
    });
    await appendTranscriptMessage(scope, {
      eventId: "contribution-question",
      message: { role: "user", content: "A new question.", timestamp: 2 },
    });
    await appendTranscriptMessage(scope, {
      eventId: "contribution-answer",
      message: { role: "assistant", content: "A new answer.", timestamp: 3 },
    });
    await appendTranscriptMessage(scope, {
      eventId: "later-conversation",
      message: { role: "user", content: marker + "later question", timestamp: 4 },
    });
    await waitForSessionTranscriptProjection(scope);
    const from = readActiveTranscriptEntryAnchor({ ...scope, entryId: "contribution-question" });
    const through = readActiveTranscriptEntryAnchor({ ...scope, entryId: "contribution-answer" });
    if (!from || !through) {
      throw new Error("Synthetic contribution anchors missing");
    }
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const acquired = countAcquiredTranscriptPayloadBytes(db, marker, () => {
      const context = readSessionTranscriptModelContext(scope, through, {
        from,
        maxBytes: 2_048,
        maxEvents: 2,
      });
      expect(context.events.map((event) => (event as { id: string }).id)).toEqual([
        "contribution-question",
        "contribution-answer",
      ]);
      expect(context.truncated).toBeUndefined();
      expect(JSON.stringify(context.events)).not.toContain(marker);
      expect(
        readSessionTranscriptModelContext(scope, from, {
          from,
          maxBytes: 2_048,
          maxEvents: 1,
        }).events,
      ).toMatchObject([{ id: "contribution-question" }]);
    });
    expect(acquired).toBe(0);
  });
});

it("refuses missing, forged, foreign and reversed contribution anchors", async () => {
  await withBoundedContextScope(async (scope) => {
    for (const [index, id] of ["first", "last", "after"].entries()) {
      await appendTranscriptMessage(scope, {
        eventId: id,
        message: { role: "user", content: id, timestamp: index + 1 },
      });
    }
    await waitForSessionTranscriptProjection(scope);
    const from = readActiveTranscriptEntryAnchor({ ...scope, entryId: "first" });
    const through = readActiveTranscriptEntryAnchor({ ...scope, entryId: "last" });
    const after = readActiveTranscriptEntryAnchor({ ...scope, entryId: "after" });
    if (!from || !through || !after) {
      throw new Error("Synthetic contribution anchors missing");
    }
    const limits = { maxBytes: 2_048, maxEvents: 4 };
    expect(() => readSessionTranscriptModelContext(scope, undefined, { ...limits, from })).toThrow(
      SessionTranscriptReadFenceError,
    );
    for (const invalid of [
      { ...from, entryId: "" },
      { ...from, entryId: "missing" },
      { ...from, agentId: "other" },
      { ...from, sessionKey: "agent:main:other" },
      { ...from, sessionId: "other" },
      { ...from, storePath: `${from.storePath}.other` },
      { ...from, generation: "other" },
      { ...from, rawSeq: from.rawSeq + 1 },
      { ...from, activeMessagePosition: from.activeMessagePosition + 1 },
      after,
    ]) {
      expect(() =>
        readSessionTranscriptModelContext(scope, through, {
          ...limits,
          from: invalid,
        }),
      ).toThrow(SessionTranscriptReadFenceError);
    }
  });
});

it("refuses a contribution boundary that would detach a tool result from its native owner", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("tool-question", null, { role: "user", content: "Read a value." }),
        transcriptMessage(
          "tool-owner",
          "tool-question",
          makeAgentAssistantMessage({
            content: [{ type: "toolCall", id: "range-call", name: "read", arguments: {} }],
            stopReason: "toolUse",
          }),
        ),
        transcriptMessage("tool-result", "tool-owner", {
          role: "toolResult",
          toolCallId: "range-call",
          toolName: "read",
          content: [{ type: "text", text: "A value." }],
          isError: false,
          timestamp: 1,
        }),
        transcriptMessage("tool-answer", "tool-result", { role: "assistant", content: "Done." }),
      ],
      touchSessionEntry: false,
    });
    await waitForSessionTranscriptProjection(scope);
    const from = readActiveTranscriptEntryAnchor({ ...scope, entryId: "tool-result" });
    const question = readActiveTranscriptEntryAnchor({ ...scope, entryId: "tool-question" });
    const through = readActiveTranscriptEntryAnchor({ ...scope, entryId: "tool-answer" });
    if (!from || !question || !through) {
      throw new Error("Synthetic tool range anchors missing");
    }
    const limits = { maxBytes: 16_384, maxEvents: 10 };
    expect(() => readSessionTranscriptModelContext(scope, through, { ...limits, from })).toThrow(
      SessionTranscriptReadFenceError,
    );
    expect(
      readSessionTranscriptModelContext(scope, through, {
        ...limits,
        from: question,
      }).events.map((event) => (event as { id: string }).id),
    ).toEqual(["tool-question", "tool-owner", "tool-result", "tool-answer"]);
  });
});

it.each(["compaction", "reset"] as const)(
  "refuses contribution ranges crossing a %s instead of importing its older context",
  async (type) => {
    await withBoundedContextScope(async (scope) => {
      await appendTranscriptMessage(scope, {
        eventId: "retained-start",
        message: { role: "user", content: "Earlier question.", timestamp: 1 },
      });
      await appendTranscriptEvent(scope, {
        type,
        id: "range-boundary",
        parentId: "retained-start",
        firstKeptEntryId: "retained-start",
        summary: "A summary may contain information before the requested range.",
        reason: "new",
        tokensBefore: 100,
      });
      await appendTranscriptMessage(scope, {
        eventId: "range-end",
        message: { role: "assistant", content: "Later answer.", timestamp: 2 },
      });
      await waitForSessionTranscriptProjection(scope);
      const from = readActiveTranscriptEntryAnchor({ ...scope, entryId: "retained-start" });
      const through = readActiveTranscriptEntryAnchor({ ...scope, entryId: "range-end" });
      if (!from || !through) {
        throw new Error("Synthetic retained contribution anchors missing");
      }
      expect(() =>
        readSessionTranscriptModelContext(scope, through, {
          from,
          maxBytes: 2_048,
          maxEvents: 10,
        }),
      ).toThrow(SessionTranscriptReadFenceError);
      await appendTranscriptEvent(scope, {
        type: "compaction",
        id: "exclude-start",
        parentId: "range-end",
        firstKeptEntryId: "range-end",
        summary: "The old start is no longer in model context.",
        tokensBefore: 100,
      });
      await waitForSessionTranscriptProjection(scope);
      expect(() =>
        readSessionTranscriptModelContext(scope, through, {
          from,
          maxBytes: 2_048,
          maxEvents: 10,
        }),
      ).toThrow(SessionTranscriptReadFenceError);
    });
  },
);

async function seedImportedTranscript(
  scope: Parameters<Parameters<typeof withBoundedContextScope>[0]>[0],
  events: unknown[],
) {
  await seedUnindexedTranscriptForTest({
    ...scope,
    entry: { sessionId: scope.sessionId, updatedAt: 1 },
    events: events.map((event, seq) => ({
      session_id: scope.sessionId,
      seq,
      created_at: seq,
      event_json: JSON.stringify(event),
    })),
  });
}

function readHistory(
  scope: Parameters<typeof readSessionTranscriptBoundedMessageTailPage>[0],
  maxBytes = 1024 * 1024,
) {
  return readSessionTranscriptBoundedMessageTailPage(scope, {
    maxBytes,
    maxMessages: 100,
    offset: 0,
  });
}

it("enforces context count and byte budgets and releases rejected reads for later appends", async () => {
  await withBoundedContextScope(async (scope) => {
    const append = (id: string, parent: string | null, content = id) =>
      persistSessionTranscriptTurn(scope, {
        messages: [transcriptMessage(id, parent, { role: "user", content })],
        touchSessionEntry: false,
      });
    await append("old", null);
    await append("large", "old", "🦞".repeat(1024));
    await append("new", "large");
    const read = (maxBytes: number, maxEvents = 100) =>
      readSessionTranscriptBoundedActiveContextCore(scope, { maxBytes, maxEvents });
    const ids = (context: ReturnType<typeof read>) =>
      context.events.map((event) => (event as { id: string }).id);
    const counted = read(16_384, 2);
    expect(ids(counted)).toEqual([scope.sessionId, "large", "new"]);
    expect(counted).toMatchObject({ activeLeafEntryId: "new", totalEvents: 3, truncated: true });
    expect(counted.serializedBytes).toBe(
      counted.events.reduce<number>(
        (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
        0,
      ),
    );
    expect(counted.serializedBytes).toBeLessThanOrEqual(16_384);
    expect(read(16_384, 3).truncated).toBe(false);
    const headerBytes = Buffer.byteLength(JSON.stringify(counted.events[0])) + 1;
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const counter = trackSqliteStatementExecutions(db, ["sizing"], (sql) =>
      sql.includes("serialized_bytes") ? "sizing" : null,
    );
    const bounded = (maxBytes: number, maxRows: number) => {
      const before = counter.rowCounts.sizing;
      const context = read(maxBytes);
      expect(counter.rowCounts.sizing - before).toBeGreaterThan(0);
      expect(counter.rowCounts.sizing - before).toBeLessThanOrEqual(maxRows);
      expect(context.truncated).toBe(true);
      return context;
    };
    try {
      expect(ids(bounded(1024, 3))).toEqual([scope.sessionId, "new"]);
      const exact = bounded(headerBytes, 2);
      expect(ids(exact)).toEqual([scope.sessionId]);
      expect(exact.events[0]).toMatchObject({ type: "session" });
      expect(exact.serializedBytes).toBe(headerBytes);
      await append("oversized", "new", "🦞".repeat(1024));
      expect(ids(bounded(1024, 2))).toEqual([scope.sessionId]);
      await append("next", "oversized");
      expect(ids(bounded(1024, 3))).toEqual([scope.sessionId, "next"]);
    } finally {
      counter.restore();
    }
  });
});

it("rejects an oversized header before acquiring its payload", async () => {
  await withBoundedContextScope(async (scope) => {
    const marker = "synthetic-oversized-header:";
    await appendTranscriptEvent(scope, {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: scope.sessionId,
      cwd: marker + "x".repeat(4096),
    });
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const acquiredBytes = countAcquiredTranscriptPayloadBytes(db, marker, () => {
      expect(() =>
        readSessionTranscriptBoundedActiveContextCore(scope, { maxBytes: 1024, maxEvents: 10 }),
      ).toThrow("Session transcript header exceeds the active-context byte limit");
    });
    expect(acquiredBytes).toBe(0);
  });
});

it("omits an oversized latest compaction boundary before acquiring its payload", async () => {
  await withBoundedContextScope(async (scope) => {
    const manager = SessionManager.open(scope);
    const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
    const marker = "synthetic-oversized-boundary:";
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "oversized-boundary",
      parentId: kept,
      timestamp: "2026-08-30T00:00:00.000Z",
      firstKeptEntryId: kept,
      summary: "summary",
      tokensBefore: 100,
      details: { payload: marker + "x".repeat(4096) },
    });
    await appendTranscriptMessage(scope, {
      eventId: "tail",
      message: { role: "user", content: "latest", timestamp: 2 },
    });
    await waitForSessionTranscriptProjection(scope);
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const acquiredBytes = countAcquiredTranscriptPayloadBytes(db, marker, () => {
      const context = readSessionTranscriptBoundedActiveContextCore(scope, {
        maxBytes: 1024,
        maxEvents: 1,
      });
      expect(context.events.map((event) => (event as { id: string }).id)).toEqual([
        scope.sessionId,
        "tail",
      ]);
      expect(context.truncated).toBe(true);
      expect(context.boundaryCount).toBe(1);
      expect(context.serializedBytes).toBe(
        context.events.reduce<number>(
          (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
          0,
        ),
      );
    });
    expect(acquiredBytes).toBe(0);
  });
});

it("selects imported headers and retention anchors before later indexed duplicates", async () => {
  await withBoundedContextScope(async (scope) => {
    const events = [
      {
        type: "message",
        id: "mirror",
        parentId: null,
        message: { role: "assistant", content: "New session started." },
      },
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "kept",
        parentId: "mirror",
        message: { role: "user", content: "Imported kept question." },
      },
      {
        type: "compaction",
        id: "cut",
        parentId: "kept",
        firstKeptEntryId: "kept",
        summary: "Summary.",
      },
      {
        type: "message",
        id: "reply",
        parentId: "cut",
        message: { role: "assistant", content: "Original reply." },
      },
    ];
    await seedImportedTranscript(scope, events);
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM transcript_event_identities WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ count: 0 });
    await appendTranscriptMessage(scope, {
      eventId: "kept",
      parentId: "reply",
      message: { role: "assistant", content: "Later indexed duplicate.".repeat(100) },
    });
    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 32_768,
      maxEvents: 10,
    });
    expect(context.events[0]).toMatchObject({ type: "session", version: 3, id: scope.sessionId });
    const range = context.firstKeptRanges.get("cut");
    expect(range).toBeDefined();
    expect(context.events.slice(range!.startIndex, range!.endIndex)).toEqual([
      expect.objectContaining({
        id: "kept",
        message: { role: "user", content: "Imported kept question." },
      }),
    ]);
    expect(
      readSessionTranscriptHistoryEventById(scope, "kept", { currentOnly: true, maxBytes: 100 }),
    ).toBeUndefined();
  });
});

it("retains the latest boundary and counts earlier resets before a truncated tail", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [transcriptMessage("old", null, { role: "user", content: "old" })],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "prior-reset",
      parentId: "old",
      timestamp: "2026-08-24T00:00:00.000Z",
      reason: "new",
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "summary",
      parentId: "prior-reset",
      timestamp: "2026-08-25T00:00:00.000Z",
      summary: "earlier work",
      firstKeptEntryId: "old",
      tokensBefore: 100,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("middle", "summary", { role: "user", content: "middle" }),
        transcriptMessage("new", "middle", { role: "assistant", content: "new" }),
      ],
      touchSessionEntry: false,
    });

    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 2048,
      maxEvents: 1,
    });

    expect(context.events.map((event) => (event as { id?: string }).id)).toEqual([
      scope.sessionId,
      "summary",
      "new",
    ]);
    expect(context.events.at(-1)).toMatchObject({ parentId: "middle" });
    expect(context.opaqueParents.get("middle")).toBe("summary");
    expect(context.boundaryCount).toBe(2);
    expect(
      readSessionTranscriptBoundedActiveContextUsageCore(scope, {
        maxBytes: 2048,
        maxEvents: 1,
      }),
    ).toEqual({
      eventCount: 3,
      serializedBytes: context.serializedBytes,
      truncated: context.truncated,
    });
  });
});

it("keeps reset history closed across compaction with a warm history cache", async () => {
  await withBoundedContextScope(async (scope) => {
    const manager = SessionManager.open(scope);
    const appendUser = (content: string) =>
      manager.appendMessage({ role: "user", content, timestamp: 1 });
    const settle = async () => {
      manager.flushPendingPersistence();
      await waitForSessionTranscriptProjection(scope);
    };
    const expectHistory = (ids: string[]) => {
      const page = readHistory(scope);
      expect(page.totalMessages).toBe(ids.length);
      expect(page.events.map(({ event }) => (event as { id: string }).id)).toEqual(ids);
    };

    appendUser("before-reset user");
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "before-reset assistant" }],
      }),
    );
    manager.appendResetBoundary("new");
    const freshUserId = appendUser("fresh user");
    await settle();
    expectHistory([freshUserId]);

    manager.appendCompaction("fresh-only summary", freshUserId, 100);
    await settle();
    expectHistory([freshUserId]);
    expect(manager.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "fresh-only summary" },
      { role: "user", content: "fresh user" },
    ]);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(2);

    const nextUserId = appendUser("after compaction");
    await settle();
    expectHistory([freshUserId, nextUserId]);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(3);

    // A newer reset wins for both scopes; another compaction must not revive older resets.
    manager.appendResetBoundary("new", nextUserId);
    const newestUserId = appendUser("after second reset");
    await settle();
    expectHistory([nextUserId, newestUserId]);
    expect(manager.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "after compaction" },
      { role: "user", content: "after second reset" },
    ]);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(2);

    manager.appendCompaction("newest-only summary", newestUserId, 100);
    await settle();
    expectHistory([nextUserId, newestUserId]);
    const reopened = SessionManager.open(scope);
    expect(reopened.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "newest-only summary" },
      { role: "user", content: "after second reset" },
    ]);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(2);
  });
});

it("counts paired reset tool results without counting discarded orphan results", async () => {
  await withBoundedContextScope(async (scope) => {
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      stopReason: "toolUse",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("discarded-old", null, {
          role: "user",
          content: `discarded ${"x".repeat(12_000)}`,
        }),
        transcriptMessage("kept-user", "discarded-old", { role: "user", content: "kept question" }),
        transcriptMessage("kept-assistant", "kept-user", assistantMessage),
        transcriptMessage("kept-result", "kept-assistant", {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: `paired ${"p".repeat(3_000)}` }],
          isError: false,
          timestamp: Date.parse("2026-08-15T00:00:01.000Z"),
        }),
        transcriptMessage("discarded-orphan", "kept-result", {
          role: "toolResult",
          toolCallId: "orphan-call",
          toolName: "read",
          content: [{ type: "text", text: `orphan ${"o".repeat(20_000)}` }],
          isError: false,
          timestamp: Date.parse("2026-08-15T00:00:02.000Z"),
        }),
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "discarded-orphan",
      timestamp: "2026-08-15T00:00:03.000Z",
      reason: "new",
      firstKeptEntryId: "kept-user",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("post-reset", "reset-boundary", { role: "user", content: "fresh turn" }),
      ],
      touchSessionEntry: false,
    });

    const stats = readActiveTranscriptStats(scope);
    expect(stats.eventCount).toBe(4);
    expect(stats.sizeBytes).toBeGreaterThan(3_000);
    expect(stats.sizeBytes).toBeLessThan(8_000);
    expect(readHistory(scope).totalMessages).toBe(3);

    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("second-post-reset", "post-reset", {
          role: "assistant",
          content: "fresh answer",
        }),
      ],
      touchSessionEntry: false,
    });
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      expect(readActiveTranscriptStats(scope).eventCount).toBe(5);
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }

    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "fresh-compaction",
      parentId: "second-post-reset",
      timestamp: "2026-08-15T00:00:04.000Z",
      summary: "fresh-only summary",
      firstKeptEntryId: "post-reset",
      tokensBefore: 100,
    });
    const history = readHistory(scope);
    expect(history.totalMessages).toBe(4);
    expect(history.events.map(({ event }) => (event as { id: string }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
      "second-post-reset",
    ]);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(3);
    expect(readActiveTranscriptStats(scope).sizeBytes).toBeLessThan(8_000);
  });
});

it("counts retained raw bytes without hydrating private native payloads", async () => {
  await withBoundedContextScope(async (scope) => {
    const marker = "synthetic-retained-native-payload:";
    const privateText = marker + "x".repeat(1024 * 1024);
    const manager = SessionManager.open(scope);
    const kept = manager.appendMessage({
      role: "user",
      content: "kept",
      timestamp: 1,
      __openclaw: { upstreamUserText: privateText },
    } as Parameters<SessionManager["appendMessage"]>[0]);
    manager.appendResetBoundary("new", kept);
    await waitForSessionTranscriptProjection(scope);
    const originalParse = JSON.parse;
    let privateBytes = 0;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes(marker)) {
        privateBytes += text.length;
      }
      return originalParse(text, reviver);
    });
    try {
      const stats = readActiveTranscriptStats(scope);
      expect(stats.eventCount).toBe(1);
      expect(stats.sizeBytes).toBeGreaterThan(privateText.length);
      expect(privateBytes).toBe(0);
    } finally {
      parseSpy.mockRestore();
    }
  });
});

it("keeps later unindexed feedback payloads outside an admitted context read", async () => {
  await withBoundedContextScope(async (scope) => {
    const events = [
      { type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId },
      {
        type: "message",
        id: "imported-user",
        parentId: null,
        message: { role: "user", content: "Imported conversation." },
      },
    ];
    await seedImportedTranscript(scope, events);
    const admitted = await appendTranscriptMessage(scope, {
      eventId: "current-user",
      parentId: "imported-user",
      message: { role: "user", content: "Current request.", timestamp: 2 },
    });
    const anchor = admitted.anchor;
    if (!anchor) {
      throw new Error("missing admission anchor");
    }
    const marker = "synthetic-later-feedback-payload:";
    const privateText = marker + "x".repeat(4096);
    const details: unknown = JSON.parse(
      `${"[".repeat(1_001)}${JSON.stringify(privateText)}${"]".repeat(1_001)}`,
    );
    const { recordChannelFeedbackEvent } = await import("openclaw/plugin-sdk/channel-inbound");
    expect(
      await recordChannelFeedbackEvent({
        cfg: { session: { store: scope.storePath } },
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        event: {
          type: "custom_message",
          customType: "synthetic-feedback",
          content: "Later feedback.",
          display: true,
          details,
        },
      }),
    ).toBe(true);
    await waitForSessionTranscriptProjection(scope);
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const acquiredBytes = countAcquiredTranscriptPayloadBytes(db, marker, () => {
      runWithSessionTranscriptReadFence(
        { ...anchor, logicalTurnId: "current", role: "user" },
        () => {
          const context = readSessionTranscriptBoundedActiveContextCore(scope, {
            maxBytes: 1024,
            maxEvents: 10,
          });
          expect(context.events.map((event) => (event as { id: string }).id)).toEqual([
            scope.sessionId,
            "imported-user",
          ]);
          expect(context.activeLeafEntryId).toBe("imported-user");
          expect(
            readSessionTranscriptBoundedActiveContextUsageCore(scope, {
              maxBytes: 1024,
              maxEvents: 10,
            }),
          ).toEqual({
            eventCount: context.events.length,
            serializedBytes: context.serializedBytes,
            truncated: context.truncated,
          });
        },
      );
    });
    expect(acquiredBytes).toBe(0);
  });
});

it("keeps usage and bootstrap facts in the rebuilt bounded tail despite display activity", async () => {
  await withBoundedContextScope(async (scope) => {
    await appendTranscriptEvent(scope, {
      type: "custom",
      id: "bootstrap",
      parentId: null,
      customType: "bootstrap-completed",
      data: {},
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("usage", "bootstrap", {
          role: "assistant",
          content: "answer",
          usage: { input: 86_000, output: 2_000 },
        }),
        ...Array.from({ length: 513 }, (_, index) => ({
          eventId: `display-${index}`,
          parentId: index === 0 ? "usage" : `display-${index - 1}`,
          message: {
            role: "custom",
            customType: "tool-activity",
            display: true,
            excludeFromContext: true,
            content: "completed",
          },
        })),
      ],
      touchSessionEntry: false,
    });

    openOpenClawAgentDatabase(scope)
      .db.prepare(
        "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
      )
      .run(scope.sessionId);
    expect(await reconcileSessionTranscriptIndexes(scope)).toEqual({ reconciledSessions: 1 });
    const tail = readRecentSessionTranscriptActiveEvents(scope, 2);
    expect(tail.map((event) => (event as { id: string }).id)).toEqual(["bootstrap", "usage"]);
    expect(tail[1]).toMatchObject({ message: { usage: { input: 86_000, output: 2_000 } } });
    const visited: unknown[] = [];
    withRecentActiveTranscriptEvents(scope, 2, (visit) => {
      visit((event) => visited.push(event));
    });
    expect(visited).toEqual(tail.toReversed());
    expect(readTranscriptStatsSync(scope).eventCount).toBeGreaterThan(513);
  });
});

it("keeps repeated visits on one snapshot and expires their reader on return", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [transcriptMessage("seed", null, { role: "user", content: "before" })],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase(scope);
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(database.path);
    let savedVisit: ((visitor: (event: unknown) => void) => void) | undefined;
    const first: unknown[] = [];
    const second: unknown[] = [];
    try {
      withRecentActiveTranscriptEvents(scope, 1, (visit) => {
        savedVisit = visit;
        visit((event) => first.push(event));
        writer.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?").run(
          JSON.stringify({
            type: "message",
            id: "seed",
            parentId: null,
            message: { role: "user", content: "after" },
          }),
          scope.sessionId,
        );
        visit((event) => second.push(event));
      });
    } finally {
      writer.close();
    }
    expect(first).toMatchObject([{ message: { content: "before" } }]);
    expect(second).toEqual(first);
    expect(readRecentSessionTranscriptActiveEvents(scope, 1)).toMatchObject([
      { message: { content: "after" } },
    ]);
    expect(() => savedVisit?.(() => {})).toThrow("outside its read snapshot");
  });
});

it.each(["json", "sql", "consumer"] as const)(
  "preserves %s failure precedence and releases the read cursor",
  async (failureKind) => {
    await withBoundedContextScope(async (scope) => {
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("oldest", null, { role: "user", content: "oldest" }),
          transcriptMessage("middle", "oldest", { role: "assistant", content: "middle" }),
          transcriptMessage("newest", "middle", { role: "user", content: "newest" }),
        ],
        touchSessionEntry: false,
      });
      const database = openOpenClawAgentDatabase(scope);
      const failure = new Error("consumer stopped");
      const malformed = '{"old":}';
      let parseFailure: Error | undefined;
      try {
        JSON.parse(malformed);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        parseFailure = error;
      }
      if (failureKind !== "consumer") {
        // The connection-local view corrupts reads without changing canonical rows or projections.
        database.db.exec(`CREATE TEMP VIEW transcript_events AS
        SELECT event.session_id, event.seq, event.created_at,
          event.event_zstd, event.event_utf8_bytes, event.navigation_json,
          CASE identity.event_id
            WHEN 'oldest' THEN ${failureKind === "sql" ? "json_extract('{broken', '$')" : "'{\"old\":}'"}
            WHEN 'middle' THEN '{"newer":}'
            ELSE event.event_json
          END AS event_json
        FROM main.transcript_events AS event
        JOIN transcript_event_identities AS identity
          ON identity.session_id = event.session_id AND identity.seq = event.seq`);
      }
      try {
        if (failureKind === "consumer") {
          expect(() =>
            withRecentActiveTranscriptEvents(scope, 3, (visit) => {
              visit(() => {
                throw failure;
              });
            }),
          ).toThrow(failure);
        } else {
          expect(() => readRecentSessionTranscriptActiveEvents(scope, 3)).toThrow(
            failureKind === "sql" ? "malformed JSON" : parseFailure,
          );
        }
      } finally {
        if (failureKind !== "consumer") {
          database.db.exec("DROP VIEW temp.transcript_events");
        }
      }
      expect(database.db.isTransaction).toBe(false);
      expect(database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({
        busy: 0,
      });
      expect(readRecentSessionTranscriptActiveEvents(scope, 3)).toHaveLength(3);
      await appendTranscriptEvent(scope, { type: "custom", id: "after", parentId: "newest" });
      expect(readRecentSessionTranscriptActiveEvents(scope, 1)).toMatchObject([{ id: "after" }]);
    });
  },
);

it.each(["unbounded", "reset"] as const)(
  "does not count display-only activity toward %s context pressure",
  async (boundary) => {
    await withBoundedContextScope(async (scope) => {
      const activity = {
        role: "custom",
        customType: "tool-activity",
        display: true,
        excludeFromContext: true,
        content: "",
        details: { output: "x".repeat(32_000) },
        timestamp: 1,
      };
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("kept-user", null, { role: "user", content: "question" }),
          transcriptMessage("display-prefix", "kept-user", activity),
          transcriptMessage("kept-assistant", "display-prefix", {
            role: "assistant",
            content: "answer",
          }),
        ],
        touchSessionEntry: false,
      });
      if (boundary !== "unbounded") {
        await appendTranscriptEvent(scope, {
          type: boundary,
          id: "boundary",
          parentId: "kept-assistant",
          timestamp: "2026-08-28T00:00:00.000Z",
          firstKeptEntryId: "kept-user",
          reason: "reset",
        });
      }
      const contextIds = new Set(["kept-user", "kept-assistant"]);
      const contextEvents = loadTranscriptEventsSync(scope).filter((event) =>
        contextIds.has((event as { id: string }).id),
      );
      const expected = {
        eventCount: contextEvents.length,
        sizeBytes: contextEvents.reduce<number>(
          (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8") + 1,
          0,
        ),
      };
      expect(readActiveTranscriptStats(scope)).toEqual(expected);
      const physicalBefore = readTranscriptStatsSync(scope);
      const historyBefore = readSessionTranscriptMessageEventCount(scope);
      await persistSessionTranscriptTurn(scope, {
        messages: [{ eventId: "display-tail", message: activity }],
        touchSessionEntry: false,
      });

      expect(readActiveTranscriptStats(scope)).toEqual(expected);
      expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(
        physicalBefore.sizeBytes + 32_000,
      );
      expect(readSessionTranscriptMessageEventCount(scope)).toBe(historyBefore + 1);
    });
  },
);
