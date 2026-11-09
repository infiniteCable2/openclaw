import assert from "node:assert/strict";
import { expect, vi } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { withSqliteReaderOwner } from "../../infra/sqlite-reader-lifecycle.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  persistSessionTranscriptTurn,
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
} from "./session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore as boundedContext } from "./session-accessor.sqlite-active-context.js";
import { readRecentSessionTranscriptActiveEvents as recentEvents } from "./session-accessor.sqlite-active-events.js";
import {
  assistant,
  compaction,
  eventIds,
  it,
  observePayloadAcquisition,
  persist,
  readContext,
  readHistory,
  readSessionTranscriptMessageEventCount,
  reset,
  seedImportedTranscript,
  serializedBytes,
  storedMessage,
  toolResult,
  user,
  withBoundedContextScope,
} from "./session-accessor.sqlite-bounded-context.fixture.js";
import { countAcquiredTranscriptPayloadBytes } from "./session-accessor.sqlite-bounded-context.test-support.js";
import {
  clearHistoryNavigation,
  readActiveTranscriptStats as activeStats,
  readSessionTranscriptHistoryEventById as historyEvent,
  withRecentActiveTranscriptEvents as visitRecentEvents,
} from "./session-accessor.sqlite-history.test-support.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-admitted-read.js";
import {
  SessionTranscriptReadFenceError,
  runWithSessionTranscriptReadFence,
} from "./session-transcript-read-fence.js";
import {
  waitForSessionTranscriptProjection,
  waitForSessionTranscriptProjection as waitProjection,
} from "./session-transcript-reconcile.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

it("keeps bounded hydration identical with complete, partial and absent active facts", async ({
  scope,
}) => {
  const compare = async (ids: string[], maxEvents = 1) => {
    await waitProjection(scope);
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const { db } = database;
    const countFacts = () =>
      db
        .prepare(
          "SELECT count(*) AS count FROM session_transcript_active_event_facts WHERE session_id = ?",
        )
        .get(scope.sessionId)?.count;
    const count = countFacts();
    expect(count).toBeGreaterThan(0);
    const read = () =>
      boundedContext(scope, { maxBytes: 16_384, maxEvents, transaction: database });
    db.exec("SAVEPOINT active_fact_coverage");
    try {
      const full = read();
      const stats = activeStats(scope);
      expect(eventIds(full.events)).toEqual([scope.sessionId, ...ids]);
      expect(full.serializedBytes).toBe(serializedBytes(full.events));
      for (const predicate of ["AND seq % 2 = 0", ""]) {
        db.prepare(
          `DELETE FROM session_transcript_active_event_facts WHERE session_id = ? ${predicate}`,
        ).run(scope.sessionId);
        expect(read()).toEqual(full);
        expect(activeStats(scope)).toEqual(stats);
      }
      expect(countFacts()).toBe(0);
    } finally {
      db.exec("ROLLBACK TO active_fact_coverage; RELEASE active_fact_coverage");
    }
    expect(countFacts()).toBe(count);
  };
  const pending = {
    ...makeAgentAssistantMessage({
      provider: "openclaw",
      model: "automation-result",
      content: [{ type: "text" as const, text: "Retained background result" }],
    }),
    excludeFromContext: true,
    openclawModelPlacement: "pending",
  };
  await persist(scope, [
    user("root", null),
    transcriptMessage("pending", "root", pending),
    transcriptMessage("excluded", "pending", { ...pending, model: "ordinary" }),
    user("tail", "excluded"),
  ]);
  await compare(["pending", "tail"]);
  await appendTranscriptEvent(scope, {
    type: "custom",
    id: "placement",
    parentId: "tail",
    customType: BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
    data: { afterEntryId: "tail", resultEntryIds: ["pending"] },
  });
  await persist(scope, [user("next", "placement")]);
  await compare(["pending", "placement", "next"], 2);
  await appendTranscriptEvent(scope, reset("reset", "next"));
  await persist(scope, [user("fresh", "reset")]);
  await compare(["reset", "fresh"]);
  await appendTranscriptEvent(scope, compaction("summary", "fresh", "fresh", "Earlier work"));
  await persist(scope, [user("newest", "summary")]);
  await compare(["summary", "newest"]);
  await appendTranscriptEvent(scope, {
    type: "leaf",
    id: "switch",
    parentId: "newest",
    // Leaf selection cannot cross the latest reset boundary.
    targetId: "fresh",
  });
  await compare(["reset", "fresh"]);
  await persist(scope, [user("branch", "fresh")]);
  await compare(["reset", "branch"]);
});

it("reports slow hydration scan shape without formatting fast reads or draining byte-limited scans", async ({
  scope,
}) => {
  await persist(scope, [
    user("old", null),
    transcriptMessage("pending", "old", {
      ...makeAgentAssistantMessage({
        provider: "openclaw",
        model: "automation-result",
        content: [],
      }),
      excludeFromContext: true,
      openclawModelPlacement: "pending",
    }),
    user("large", "pending", "x".repeat(4096)),
    user("tail", "large"),
  ]);
  await waitProjection(scope);
  const opened = openOpenClawAgentDatabaseReadOnly({ agentId: scope.agentId });
  assert(opened.found);
  const database = opened.database;
  const counter = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["metadata", "dependency"],
    (sql) =>
      sql.startsWith('select "active"."event_seq", "active"."active_position"')
        ? "metadata"
        : sql.startsWith('with "dependency"')
          ? "dependency"
          : null,
  );
  const logger = { warn: vi.fn() };
  const formatAgent = vi.fn(() => "main");
  try {
    for (const [maxEvents, maxBytes, metadataRows, exhausted] of [
      [10, 16_384, 3, 1],
      [1, 16_384, 2, 0],
      [10, 1024, 2, 0],
    ] as const) {
      for (const slow of [false, true]) {
        logger.warn.mockClear();
        formatAgent.mockClear();
        counter.counts.metadata = counter.counts.dependency = 0;
        counter.rowCounts.metadata = counter.rowCounts.dependency = 0;
        withSqliteReaderOwner(
          { operation: "sessions.transcript-hydration.cron-model", ownerKind: "worker" },
          () => {
            runSqliteReadSnapshotSync(
              database.db,
              () => boundedContext(scope, { maxEvents, maxBytes, transaction: database }),
              {
                logger,
                slowTransactionHoldMs: slow ? 0 : Infinity,
              },
            );
            if (slow) {
              runSqliteReadSnapshotSync(database.db, () => undefined, {
                logger,
                slowTransactionHoldMs: 0,
              });
            }
          },
          {
            get agentId() {
              return formatAgent();
            },
          },
        );
        expect(counter.counts).toEqual({ metadata: 1, dependency: 1 });
        expect(counter.rowCounts).toEqual({ metadata: metadataRows, dependency: 1 });
        if (!slow) {
          expect(logger.warn).not.toHaveBeenCalled();
          expect(formatAgent).not.toHaveBeenCalled();
          continue;
        }
        expect(logger.warn).toHaveBeenCalledWith(
          "slow SQLite transaction hold",
          expect.objectContaining({
            operation: "sessions.transcript-hydration.cron-model",
            context: {
              agentId: "main",
              metadataRows,
              metadataLimit: maxEvents + 1,
              activeEvents: 4,
              dependencyRows: 1,
              exhausted,
            },
          }),
        );
        expect(logger.warn).toHaveBeenLastCalledWith(
          "slow SQLite transaction hold",
          expect.objectContaining({ context: { agentId: "main" } }),
        );
        expect(formatAgent).toHaveBeenCalledTimes(2);
      }
    }
  } finally {
    counter.restore();
    database.close();
  }
});

it("does not acquire unrelated excluded history while selecting background dependencies", async ({
  scope,
}) => {
  const marker = "unrelated-excluded-history";
  const excluded = Array.from({ length: 16 }, (_, index) =>
    transcriptMessage(`${marker}-${index}`, index === 0 ? null : `${marker}-${index - 1}`, {
      ...makeAgentAssistantMessage({ content: [] }),
      excludeFromContext: true,
    }),
  );
  await persist(scope, [...excluded, user("anchor", `${marker}-15`), user("tail", "anchor")]);
  await waitProjection(scope);
  const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
  const acquisition = observePayloadAcquisition(db, marker, () => {
    expect(eventIds(readContext(scope, 16384, 1).events)).toEqual([scope.sessionId, "tail"]);
  });
  expect(acquisition.acquiredBytes).toBe(0);
});

it.for([false, true])(
  "bounds legacy payload reads with an unindexed header: %s",
  async (unindexedHeader, { scope }) => {
    const marker = "unselected-legacy-payload";
    await persist(scope, [
      ...Array.from({ length: 16 }, (_, index) =>
        user(`old-${index}`, index === 0 ? null : `old-${index - 1}`, marker),
      ),
      user("tail", "old-15"),
    ]);
    await waitProjection(scope);
    runOpenClawAgentWriteTransaction(
      (database) => {
        clearHistoryNavigation(database, scope.sessionId);
        if (unindexedHeader) {
          // Imported headers can lack identity ownership while later messages are indexed.
          database.db
            .prepare(
              "DELETE FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
            )
            .run(scope.sessionId, scope.sessionId);
        }
      },
      { agentId: scope.agentId },
    );
    const database = openOpenClawAgentDatabaseReadOnly({ agentId: scope.agentId });
    assert(database.found);
    const nativeJson = new (requireNodeSqlite().DatabaseSync)(":memory:");
    const validJson = nativeJson.prepare("SELECT json_valid(?) AS valid");
    let unrelatedParses = 0;
    try {
      requireNativeSqliteDatabase(database.database.db).function(
        "json_valid",
        { deterministic: true },
        (value) => {
          unrelatedParses += Number(typeof value === "string" && value.includes(marker));
          return validJson.get(value)?.valid ?? 0;
        },
      );
      const context = runSqliteReadSnapshotSync(database.database.db, () =>
        boundedContext(scope, { maxBytes: 4096, maxEvents: 1, transaction: database.database }),
      );
      expect(eventIds(context.events)).toEqual([scope.sessionId, "tail"]);
      expect(context).toMatchObject({ totalEvents: 17, truncated: true });
      // The imported-prefix path needs the immediate predecessor's logical parent ID.
      expect(unrelatedParses).toBeLessThanOrEqual(unindexedHeader ? 1 : 0);
    } finally {
      database.database.close();
      nativeJson.close();
    }
  },
);

it("enforces context count and byte budgets and releases rejected reads for later appends", async ({
  scope,
}) => {
  const append = (id: string, parent: string | null, content = id) =>
    persist(scope, [user(id, parent, content)]);
  await append("old", null);
  await append("large", "old", "🦞".repeat(1024));
  await append("new", "large");
  const read = (maxBytes: number, maxEvents = 100) => readContext(scope, maxBytes, maxEvents);
  const ids = (context: ReturnType<typeof read>) => eventIds(context.events);
  const counted = read(16_384, 2);
  expect(ids(counted)).toEqual([scope.sessionId, "large", "new"]);
  expect(counted).toMatchObject({ activeLeafEntryId: "new", totalEvents: 3, truncated: true });
  expect(counted.serializedBytes).toBe(serializedBytes(counted.events));
  expect(counted.serializedBytes).toBeLessThanOrEqual(16_384);
  expect(read(16_384, 3).truncated).toBe(false);
  const headerBytes = Buffer.byteLength(JSON.stringify(counted.events[0])) + 1;
  const bounded = (maxBytes: number) => {
    const context = read(maxBytes);
    expect(context.truncated).toBe(true);
    return context;
  };
  expect(ids(bounded(1024))).toEqual([scope.sessionId, "new"]);
  const exact = bounded(headerBytes);
  expect(ids(exact)).toEqual([scope.sessionId]);
  expect(exact.events[0]).toMatchObject({ type: "session" });
  expect(exact.serializedBytes).toBe(headerBytes);
  await append("oversized", "new", "🦞".repeat(1024));
  expect(ids(bounded(1024))).toEqual([scope.sessionId]);
  await append("next", "oversized");
  expect(ids(bounded(1024))).toEqual([scope.sessionId, "next"]);
});

it.for(["identity", "compressed"] as const)(
  "decodes %s context payloads without expanded SQL copies",
  async (storage, { scope }) => {
    const marker = "synthetic-context-payload:";
    const content = marker + "🦞".repeat(storage === "compressed" ? 256 : 16);
    await persist(scope, [
      user("a", null, content),
      assistant("b", "a", content),
      user("c", "b", content),
    ]);
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    expect(
      db
        .prepare("SELECT count(*) AS count FROM transcript_events WHERE event_zstd IS NOT NULL")
        .get()?.count,
    ).toBe(storage === "compressed" ? 3 : 0);
    const acquisition = observePayloadAcquisition(db, marker, () => {
      const context = readContext(scope, 16_384);
      expect(eventIds(context.events)).toEqual([scope.sessionId, "a", "b", "c"]);
      expect(context.serializedBytes).toBe(serializedBytes(context.events));
      expect(recentEvents(scope, 3)).toEqual(context.events.slice(1));
    });
    expect(acquisition.decodedRows).toBe(6);
    expect(acquisition.pendingRows).toBe(0);
    expect(acquisition.peakPendingBytes).toBeLessThanOrEqual(acquisition.largestRowBytes);
    if (storage === "compressed") {
      expect(acquisition.acquiredBytes).toBe(0);
    }
  },
);

it.for(["header", "compaction"] as const)(
  "bounds oversized %s before acquiring its payload",
  async (kind, { scope }) => {
    const marker = "synthetic-oversized-payload:";
    const payload = marker + "x".repeat(4096);
    if (kind === "header") {
      await appendTranscriptEvent(scope, {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: scope.sessionId,
        cwd: payload,
      });
    } else {
      const kept = SessionManager.open(scope).appendMessage({
        role: "user",
        content: "retained",
        timestamp: 1,
      });
      await appendTranscriptEvent(scope, {
        ...compaction("oversized-boundary", kept, kept, "summary"),
        details: { payload },
      });
      await appendTranscriptMessage(scope, {
        eventId: "tail",
        message: { role: "user", content: "latest", timestamp: 2 },
      });
      await waitProjection(scope);
    }
    runOpenClawAgentWriteTransaction(
      (database) => clearHistoryNavigation(database, scope.sessionId),
      { agentId: scope.agentId },
    );
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const acquisition = observePayloadAcquisition(db, marker, () => {
      if (kind === "header") {
        expect(() => readContext(scope)).toThrow(
          "Session transcript header exceeds the active-context byte limit",
        );
      } else {
        const context = readContext(scope, 1024, 1);
        expect(eventIds(context.events)).toEqual([scope.sessionId, "tail"]);
        expect(context).toMatchObject({ truncated: true, boundaryCount: 1 });
        expect(context.serializedBytes).toBe(serializedBytes(context.events));
      }
    });
    expect(acquisition.acquiredBytes).toBe(0);
  },
);

it("selects imported headers and retention anchors before later indexed duplicates", async ({
  scope,
}) => {
  const events = [
    storedMessage("mirror", null, "assistant", "New session started."),
    { type: "session", version: 3, id: scope.sessionId },
    storedMessage("kept", "mirror", "user", "Imported kept question."),
    {
      type: "compaction",
      id: "cut",
      parentId: "kept",
      firstKeptEntryId: "kept",
      summary: "Summary.",
    },
    storedMessage("reply", "cut", "assistant", "Original reply."),
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
  const context = readContext(scope, 32_768, 10);
  expect(context.events[0]).toMatchObject({ type: "session", version: 3, id: scope.sessionId });
  const range = context.firstKeptRanges.get("cut");
  expect(range).toBeDefined();
  expect(context.events.slice(range!.startIndex, range!.endIndex)).toEqual([
    expect.objectContaining({
      id: "kept",
      message: { role: "user", content: "Imported kept question." },
    }),
  ]);
  expect(historyEvent(scope, "kept", { currentOnly: true, maxBytes: 100 })).toBeUndefined();
});

it("retains the latest boundary and counts earlier resets before a truncated tail", async ({
  scope,
}) => {
  await persist(scope, [user("old", null)]);
  await appendTranscriptEvent(scope, reset("prior-reset", "old"));
  await appendTranscriptEvent(scope, compaction("summary", "prior-reset", "old", "earlier work"));
  await persist(scope, [user("middle", "summary"), assistant("new", "middle")]);

  const context = readContext(scope, 2048, 1);

  expect(eventIds(context.events)).toEqual([scope.sessionId, "summary", "new"]);
  expect(context.events.at(-1)).toMatchObject({ parentId: "middle" });
  expect(context.parents).toEqual(
    new Map([
      ["summary", "prior-reset"],
      ["new", "middle"],
    ]),
  );
  expect(context.opaqueParents.get("middle")).toBe("summary");
  expect(context.boundaryCount).toBe(2);
});

it("keeps reset history closed across compaction with a warm history cache", async ({ scope }) => {
  const manager = SessionManager.open(scope);
  const appendUser = (content: string) =>
    manager.appendMessage({ role: "user", content, timestamp: 1 });
  const settle = async () => {
    manager.flushPendingPersistence();
    await waitProjection(scope);
  };
  const expectHistory = (ids: string[]) => {
    const page = readHistory(scope);
    expect(page.totalMessages).toBe(ids.length);
    expect(page.events.map(({ event }) => (event as { id: string }).id)).toEqual(ids);
  };
  const expectContext = (messages: unknown[]) => {
    expect(manager.buildSessionContext().messages).toMatchObject(messages);
    expect(activeStats(scope).eventCount).toBe(messages.length);
  };
  const summary = (text: string) => ({ role: "compactionSummary", summary: text });
  const message = (content: string) => ({ role: "user", content });

  appendUser("before-reset user");
  manager.appendMessage(
    makeAgentAssistantMessage({ content: [{ type: "text", text: "before-reset assistant" }] }),
  );
  manager.appendResetBoundary("new");
  const freshUserId = appendUser("fresh user");
  await settle();
  expectHistory([freshUserId]);

  manager.appendCompaction("fresh-only summary", freshUserId, 100);
  await settle();
  expectHistory([freshUserId]);
  expectContext([summary("fresh-only summary"), message("fresh user")]);

  const nextUserId = appendUser("after compaction");
  await settle();
  expectHistory([freshUserId, nextUserId]);
  expect(activeStats(scope).eventCount).toBe(3);

  manager.appendResetBoundary("new", nextUserId);
  const newestUserId = appendUser("after second reset");
  await settle();
  expectHistory([nextUserId, newestUserId]);
  expectContext([message("after compaction"), message("after second reset")]);

  manager.appendCompaction("newest-only summary", newestUserId, 100);
  await settle();
  expectHistory([nextUserId, newestUserId]);
  const reopened = SessionManager.open(scope);
  expect(reopened.buildSessionContext().messages).toMatchObject([
    summary("newest-only summary"),
    message("after second reset"),
  ]);
  expect(activeStats(scope).eventCount).toBe(2);
});

it("counts paired reset tool results without counting discarded orphan results", async ({
  scope,
}) => {
  const assistantMessage = makeAgentAssistantMessage({
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
    stopReason: "toolUse",
  });
  await persist(scope, [
    user("discarded-old", null, `discarded ${"x".repeat(12_000)}`),
    user("kept-user", "discarded-old", "kept question"),
    transcriptMessage("kept-assistant", "kept-user", assistantMessage),
    toolResult("kept-result", "kept-assistant", "call-1", `paired ${"p".repeat(3_000)}`, 1),
    toolResult("discarded-orphan", "kept-result", "orphan-call", `orphan ${"o".repeat(20_000)}`, 2),
  ]);
  await appendTranscriptEvent(scope, reset("reset-boundary", "discarded-orphan", "kept-user"));
  await persist(scope, [user("post-reset", "reset-boundary", "fresh turn")]);

  const stats = activeStats(scope);
  expect(stats.eventCount).toBe(4);
  expect(stats.sizeBytes).toBeGreaterThan(3_000);
  expect(stats.sizeBytes).toBeLessThan(8_000);
  expect(readHistory(scope).totalMessages).toBe(3);

  await persist(scope, [assistant("second-post-reset", "post-reset", "fresh answer")]);
  expect(activeStats(scope).eventCount).toBe(5);

  await appendTranscriptEvent(
    scope,
    compaction("fresh-compaction", "second-post-reset", "post-reset", "fresh-only summary"),
  );
  const history = readHistory(scope);
  expect(history.totalMessages).toBe(4);
  expect(history.events.map(({ event }) => (event as { id: string }).id)).toEqual([
    "kept-user",
    "kept-assistant",
    "post-reset",
    "second-post-reset",
  ]);
  expect(activeStats(scope).eventCount).toBe(3);
  expect(activeStats(scope).sizeBytes).toBeLessThan(8_000);
});

it("keeps later unindexed feedback payloads outside an admitted context read", async ({
  scope,
}) => {
  const events = [
    { type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId },
    storedMessage("imported-user", null, "user", "Imported conversation."),
  ];
  await seedImportedTranscript(scope, events);
  const admitted = await appendTranscriptMessage(scope, {
    eventId: "current-user",
    parentId: "imported-user",
    message: { role: "user", content: "Current request.", timestamp: 2 },
  });
  const anchor = admitted.anchor;
  assert(anchor, "missing admission anchor");
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
  await waitProjection(scope);
  const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
  const acquisition = observePayloadAcquisition(db, marker, () => {
    runWithSessionTranscriptReadFence({ ...anchor, logicalTurnId: "current", role: "user" }, () => {
      const context = readContext(scope, 1024, 10);
      expect(eventIds(context.events)).toEqual([scope.sessionId, "imported-user"]);
      expect(context.activeLeafEntryId).toBe("imported-user");
    });
  });
  expect(acquisition.acquiredBytes).toBe(0);
});

it("keeps repeated visits on one snapshot and expires their reader on return", async ({
  scope,
}) => {
  await persist(scope, [user("seed", null, "before")]);
  const database = openOpenClawAgentDatabase(scope);
  const { DatabaseSync } = requireNodeSqlite();
  const writer = new DatabaseSync(database.path);
  let savedVisit: ((visitor: (event: unknown) => void) => void) | undefined;
  const first: unknown[] = [];
  const second: unknown[] = [];
  try {
    visitRecentEvents(scope, 1, (visit) => {
      savedVisit = visit;
      visit((event) => first.push(event));
      writer
        .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?")
        .run(JSON.stringify(storedMessage("seed", null, "user", "after")), scope.sessionId);
      visit((event) => second.push(event));
    });
  } finally {
    writer.close();
  }
  expect(first).toMatchObject([{ message: { content: "before" } }]);
  expect(second).toEqual(first);
  expect(recentEvents(scope, 1)).toMatchObject([{ message: { content: "after" } }]);
  expect(() => savedVisit?.(() => {})).toThrow("outside its read snapshot");
});

it.for(["json", "sql", "compressed", "consumer"] as const)(
  "preserves %s failure precedence and releases the read cursor",
  async (failureKind, { scope }) => {
    await persist(scope, [
      user("oldest", null),
      assistant("middle", "oldest"),
      user("newest", "middle"),
    ]);
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
          CASE WHEN identity.event_id = 'middle' AND ${failureKind === "compressed" ? 1 : 0}
            THEN x'01' ELSE event.event_zstd END AS event_zstd,
          CASE WHEN identity.event_id = 'middle' AND ${failureKind === "compressed" ? 1 : 0}
            THEN 0 ELSE event.event_utf8_bytes END AS event_utf8_bytes,
          event.navigation_json,
          CASE identity.event_id
            WHEN 'oldest' THEN ${failureKind === "sql" ? "json_extract('{broken', '$')" : "'{\"old\":}'"}
            WHEN 'middle' THEN ${failureKind === "compressed" ? "NULL" : "'{\"newer\":}'"}
            ELSE event.event_json
          END AS event_json
        FROM main.transcript_events AS event
        JOIN transcript_event_identities AS identity
          ON identity.session_id = event.session_id AND identity.seq = event.seq`);
    }
    try {
      if (failureKind === "consumer") {
        expect(() =>
          visitRecentEvents(scope, 3, (visit) => {
            visit(() => {
              throw failure;
            });
          }),
        ).toThrow(failure);
      } else {
        expect(() => recentEvents(scope, 3)).toThrow(
          failureKind === "sql"
            ? "malformed JSON"
            : failureKind === "compressed"
              ? "Invalid compressed transcript payload bounds"
              : parseFailure,
        );
      }
    } finally {
      if (failureKind !== "consumer") {
        database.db.exec("DROP VIEW temp.transcript_events");
      }
    }
    expect(database.db.isTransaction).toBe(false);
    expect(database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
    expect(recentEvents(scope, 3)).toHaveLength(3);
    await appendTranscriptEvent(scope, { type: "custom", id: "after", parentId: "newest" });
    expect(recentEvents(scope, 1)).toMatchObject([{ id: "after" }]);
  },
);

it.for(["unbounded", "reset"] as const)(
  "does not count display-only activity toward %s context pressure",
  async (boundary, { scope }) => {
    const activity = {
      role: "custom",
      customType: "tool-activity",
      display: true,
      excludeFromContext: true,
      content: "",
      details: { output: "x".repeat(32_000) },
      timestamp: 1,
    };
    await persist(scope, [
      user("kept-user", null, "question"),
      transcriptMessage("display-prefix", "kept-user", activity),
      assistant("kept-assistant", "display-prefix", "answer"),
    ]);
    if (boundary === "reset") {
      await appendTranscriptEvent(scope, {
        ...reset("boundary", "kept-assistant", "kept-user"),
        reason: "reset",
      });
    }
    const contextIds = new Set(["kept-user", "kept-assistant"]);
    const contextEvents = loadTranscriptEventsSync(scope).filter((event) =>
      contextIds.has((event as { id: string }).id),
    );
    const expected = {
      eventCount: contextEvents.length,
      sizeBytes: serializedBytes(contextEvents),
    };
    expect(activeStats(scope)).toEqual(expected);
    const physicalBefore = readTranscriptStatsSync(scope);
    const historyBefore = readSessionTranscriptMessageEventCount(scope);
    await persist(scope, [{ eventId: "display-tail", message: activity }]);

    expect(activeStats(scope)).toEqual(expected);
    expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(
      physicalBefore.sizeBytes + 32_000,
    );
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(historyBefore + 1);
  },
);

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
    for (const [maxBytes, maxEvents, truncated] of [
      [16_384, 3, undefined],
      [16_384, 2, true],
      [1_024, 3, true],
    ] as const) {
      // The second read can reuse the native navigation suffix and its omitted prefix facts.
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(
          readSessionTranscriptModelContext(scope, undefined, { maxBytes, maxEvents }).truncated,
        ).toBe(truncated);
      }
    }
    expect(readSessionTranscriptModelContext(scope).truncated).toBeUndefined();
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
