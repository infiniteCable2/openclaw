import path from "node:path";
import { vi } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import type { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore } from "./session-accessor.js";

/** One native isolated transcript owner; callers keep their existing worker and test hooks. */
export async function withBoundedContextScope(
  run: (scope: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ label: "bounded-transcript-context" }, async (state) => {
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

export function countAcquiredTranscriptPayloadBytes(
  db: ReturnType<typeof openOpenClawAgentDatabase>["db"],
  marker: string,
  read: () => void,
): number {
  clearNodeSqliteKyselyCacheForDatabase(db);
  const prepare = db.prepare.bind(db);
  const restoreStatements: Array<() => void> = [];
  let acquiredBytes = 0;
  const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((query) => {
    const statement = prepare(query);
    const iterate = statement.iterate.bind(statement);
    // Observe SQLite result acquisition, including payloads rejected before JSON.parse.
    const iterateSpy = vi.spyOn(statement, "iterate").mockImplementation(function* (...params) {
      for (const row of iterate(...params)) {
        for (const value of Object.values(row)) {
          if (typeof value === "string" && value.includes(marker)) {
            acquiredBytes += Buffer.byteLength(value);
          }
        }
        yield row;
      }
      return undefined;
    });
    restoreStatements.push(() => iterateSpy.mockRestore());
    return statement;
  });
  try {
    read();
  } finally {
    prepareSpy.mockRestore();
    for (const restore of restoreStatements) {
      restore();
    }
  }
  return acquiredBytes;
}
