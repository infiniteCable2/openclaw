import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { loadAgentEntryReadOperations } from "../../state/openclaw-agent-execution-operations.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import "../../test-utils/prepare-compiled-subprocesses.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as entryCache from "./session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import type { SessionEntryCohortRequest } from "./session-entry-read.types.js";

let state: OpenClawTestState;
let database: OpenClawAgentDatabase;
let operations: Awaited<ReturnType<typeof loadAgentEntryReadOperations>>;
let context: AgentWorkerOperationContext;
let nextId = 0;

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "initial-context-read" });
  database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  operations = await loadAgentEntryReadOperations();
  context = {
    open: () => database,
    options: { agentId: "main", path: database.path, env: state.env },
    admit: () => {},
    writeTransaction: () => {
      throw new Error("An initial context read must not write");
    },
  };
});

afterAll(async () => {
  await state.cleanup();
});

function fixture(events: TranscriptEvent[]) {
  const id = ++nextId;
  const scope = {
    agentId: "main",
    storePath: database.path,
    env: state.env,
    sessionKey: `agent:main:context-source-${id}`,
    sessionId: `context-source-${id}`,
  };
  writeSessionEntry(database, scope.sessionKey, {
    sessionId: scope.sessionId,
    lifecycleRevision: "original",
    updatedAt: 1,
    permissionMode: "full",
  });
  replaceTranscriptEventsSync(scope, [
    { type: "session", id: scope.sessionId, version: 3 },
    ...events,
  ]);
  const request: SessionEntryCohortRequest = {
    sessionKeys: [scope.sessionKey],
    initialContext: { sessionKey: scope.sessionKey, targetSessionId: `context-target-${id}` },
  };
  const read = (overrides: Partial<SessionEntryCohortRequest> = {}) =>
    operations["session.entry.read"]({ ...request, ...overrides }, context);
  return { scope, request, read };
}

const completed: TranscriptEvent = {
  type: "message",
  id: "answer",
  parentId: null,
  message: {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "A completed answer." }],
  },
};

describe("initial context entry cohort", () => {
  it("captures its source row, completed path, physical identity and version together", () => {
    const { scope, read } = fixture([
      completed,
      {
        type: "message",
        id: "unfinished",
        parentId: "answer",
        message: { role: "user", content: "Do not copy this pending instruction." },
      },
    ]);
    const result = read();
    const selected = result.initialContext;
    expect(selected?.status).toBe("prepared");
    if (selected?.status !== "prepared") {
      throw new Error("Expected a completed synthetic source");
    }
    expect(selected.context.source).toEqual(result.source);
    expect(selected.context.sourceEntry).toEqual({
      sessionId: scope.sessionId,
      lifecycleRevision: "original",
    });
    expect(selected.context.sourceVersion).toEqual(
      readTranscriptContextVersionInTransaction(database, scope.sessionId),
    );
    expect(selected.context.sourceSessionKey).toBe(scope.sessionKey);
    expect(selected.context.sourceThrough).toMatchObject({
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      entryId: "answer",
      rawSeq: 1,
    });
    expect(selected.context.sourceVersion.rawSeq).toBe(2);
    expect(selected.context.events[0]).toMatchObject({
      type: "session",
      id: selected.context.targetSessionId,
    });
    expect(JSON.stringify(selected.context.events)).toContain("A completed answer.");
    expect(JSON.stringify(selected.context.events)).not.toContain("pending instruction");
    expect(result.entries[0]?.entry.permissionMode).toBe("full");
    expect(selected.context).not.toHaveProperty("permissionMode");
  });

  it("reports an explicit empty inherited window, not an unfinished turn", () => {
    const { read } = fixture([
      {
        type: "message",
        id: "pending",
        parentId: null,
        message: { role: "user", content: "Wait" },
      },
    ]);
    expect(read().initialContext).toMatchObject({
      status: "prepared",
      contextStatus: "no-completed-turn",
      context: { events: [expect.objectContaining({ type: "session" })] },
    });
  });

  it("uses the native completed-context budget without returning skipped payloads", () => {
    const { request, read } = fixture([completed]);
    const selected = read({
      initialContext: { ...request.initialContext!, maxTokens: 1 },
    }).initialContext;
    expect(selected).toMatchObject({
      status: "skipped",
      decision: { status: "skip", reason: "parent-too-large", maxTokens: 1 },
    });
    expect(selected).not.toHaveProperty("context");
  });

  it("requires a selected source and a distinct target identity", () => {
    const { scope, request, read } = fixture([completed]);
    expect(() => read({ sessionKeys: [] })).toThrow("must belong to its entry cohort");
    expect(() =>
      read({ initialContext: { ...request.initialContext!, targetSessionId: scope.sessionId } }),
    ).toThrow("different target identity");
    expect(() =>
      read({ initialContext: { ...request.initialContext!, targetSessionId: " " } }),
    ).toThrow("different target identity");
    expect(() =>
      read({
        sessionKeys: ["agent:main:absent"],
        initialContext: { sessionKey: "agent:main:absent", targetSessionId: "unused" },
      }),
    ).toThrow("source is unavailable");
  });

  it("does not read a locked or replaced source as a new conversation", () => {
    const { scope, read } = fixture([completed]);
    writeSessionEntry(database, scope.sessionKey, {
      sessionId: scope.sessionId,
      lifecycleRevision: "original",
      updatedAt: 2,
      modelSelectionLocked: true,
    });
    expect(() => read()).toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
    writeSessionEntry(database, scope.sessionKey, {
      sessionId: "replacement",
      lifecycleRevision: "replacement",
      updatedAt: 3,
    });
    expect(() =>
      read({
        expected: {
          incarnation: operations["session.entry.read"]({ sessionKey: scope.sessionKey }, context)
            .databaseIdentity.incarnation,
          sessions: [
            {
              sessionKey: scope.sessionKey,
              sessionId: scope.sessionId,
              lifecycleRevision: "original",
            },
          ],
        },
      }),
    ).toThrow("changed during read");
  });

  it("does not mix a foreign commit into the entry-to-transcript snapshot", () => {
    const { scope, read } = fixture([completed]);
    const version = readTranscriptContextVersionInTransaction(database, scope.sessionId);
    // This live peer deliberately commits between the two reads in the cohort;
    // closing the admitted owner first would erase the race being proved.
    const peer = new (requireNodeSqlite().DatabaseSync)(database.path);
    const original = entryCache.readExactSessionEntryCandidatesInDatabase;
    const interleave = vi
      .spyOn(entryCache, "readExactSessionEntryCandidatesInDatabase")
      .mockImplementationOnce((...args) => {
        const rows = original(...args);
        peer
          .prepare(
            "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', 'new label') WHERE session_key = ?",
          )
          .run(scope.sessionKey);
        peer
          .prepare("UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?")
          .run("foreign-generation", scope.sessionId);
        return rows;
      });
    try {
      const first = read();
      expect(first.entries[0]?.entry.label).toBeUndefined();
      expect(first.initialContext).toMatchObject({
        status: "prepared",
        context: { sourceVersion: version },
      });
      const next = read();
      expect(next.entries[0]?.entry.label).toBe("new label");
      expect(next.initialContext).toMatchObject({
        status: "prepared",
        context: { sourceVersion: { generation: "foreign-generation" } },
      });
    } finally {
      interleave.mockRestore();
      peer.close();
    }
  });
});
