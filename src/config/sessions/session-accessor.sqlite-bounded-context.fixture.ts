import path from "node:path";
import { it as baseIt, vi } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import type { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { persistSessionTranscriptTurn, upsertSessionEntryCore } from "./session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore as boundedContext } from "./session-accessor.sqlite-active-context.js";
import {
  readSessionTranscriptMessageEventPage as messagePage,
  readSessionTranscriptBoundedMessageTailPage as tailPage,
} from "./session-accessor.sqlite-active-events.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

export const readSessionTranscriptMessageEventCount = (
  scope: Parameters<typeof messagePage>[0],
): number => messagePage(scope, { maxMessages: 0, offset: 0 }).totalMessages;

export type Scope = { agentId: string; sessionId: string; sessionKey: string; storePath: string };
export function persist(
  scope: Scope,
  messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"],
) {
  return persistSessionTranscriptTurn(scope, { messages, touchSessionEntry: false });
}

export function user(id: string, parent: string | null, content = id) {
  return transcriptMessage(id, parent, { role: "user", content });
}

export function assistant(id: string, parent: string | null, content = id) {
  return transcriptMessage(id, parent, { role: "assistant", content });
}

export function toolResult(id: string, parent: string, call: string, text: string, second: number) {
  return transcriptMessage(id, parent, {
    role: "toolResult",
    toolCallId: call,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.UTC(2026, 7, 15, 0, 0, second),
  });
}

export function storedMessage(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
) {
  return { type: "message", id, parentId, message: { role, content } };
}

export function compaction(
  id: string,
  parentId: string,
  firstKeptEntryId: string,
  summary: string,
) {
  return {
    type: "compaction",
    id,
    parentId,
    firstKeptEntryId,
    summary,
    timestamp: "2026-08-30T00:00:00.000Z",
    tokensBefore: 100,
  };
}

export function reset(id: string, parentId: string, firstKeptEntryId?: string) {
  return {
    type: "reset",
    id,
    parentId,
    firstKeptEntryId,
    reason: "new",
    timestamp: "2026-08-30T00:00:00.000Z",
  };
}

export function eventIds(events: unknown[]) {
  return events.map((event) => (event as { id: string }).id);
}

export function serializedBytes(events: unknown[]) {
  return events.reduce<number>(
    (total, event) => total + Buffer.byteLength(JSON.stringify(event)) + 1,
    0,
  );
}

export function readContext(scope: Scope, maxBytes = 1024, maxEvents = 10) {
  return boundedContext(scope, { maxBytes, maxEvents });
}

export async function withBoundedContextScope(run: (scope: Scope) => Promise<void>): Promise<void> {
  await withOpenClawTestState({ label: "bounded-transcript-context" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const scope = {
      agentId: "main",
      sessionId: "bounded-context",
      sessionKey: "agent:main:bounded-context",
      storePath: path.join(state.sessionsDir("main"), "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await run(scope);
  });
}

export const it = baseIt.extend<{ scope: Scope }>({
  scope: async ({ task: _task }, use) => withBoundedContextScope(use),
});

export async function seedImportedTranscript(scope: Scope, events: unknown[]) {
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

export function readHistory(scope: Scope) {
  return tailPage(scope, { maxBytes: 1024 * 1024, maxMessages: 100, offset: 0 });
}

export function observePayloadAcquisition(
  connection: ReturnType<typeof openOpenClawAgentDatabase>["db"],
  marker: string,
  read: () => void,
) {
  const db = requireNativeSqliteDatabase(connection);
  clearNodeSqliteKyselyCacheForDatabase(db);
  const prepare = db.prepare.bind(db);
  const parse = JSON.parse;
  const restoreStatements: Array<() => void> = [];
  const pending = new Map<string, number>();
  let acquiredBytes = 0;
  let largestRowBytes = 0;
  let peakPendingBytes = 0;
  let decodedRows = 0;
  const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((query) => {
    const statement = prepare(query);
    const iterate = statement.iterate.bind(statement);
    // Observe SQLite result acquisition, including payloads rejected before JSON.parse.
    const iterateSpy = vi.spyOn(statement, "iterate").mockImplementation(function* (...params) {
      for (const row of iterate(...params)) {
        for (const value of Object.values(row)) {
          if (typeof value === "string" && value.includes(marker)) {
            const bytes = Buffer.byteLength(value);
            acquiredBytes += bytes;
            pending.set(value, bytes);
            largestRowBytes = Math.max(largestRowBytes, bytes);
            peakPendingBytes = Math.max(
              peakPendingBytes,
              [...pending.values()].reduce((a, b) => a + b, 0),
            );
          }
        }
        yield row;
      }
      return undefined;
    });
    restoreStatements.push(() => iterateSpy.mockRestore());
    return statement;
  });
  const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (typeof text === "string" && text.includes(marker)) {
      decodedRows++;
      pending.delete(text);
    }
    return parse(text, reviver);
  });
  try {
    read();
  } finally {
    parseSpy.mockRestore();
    prepareSpy.mockRestore();
    for (const restore of restoreStatements) {
      restore();
    }
  }
  return {
    acquiredBytes,
    largestRowBytes,
    peakPendingBytes,
    decodedRows,
    pendingRows: pending.size,
  };
}
