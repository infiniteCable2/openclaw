import { isMainThread } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { assertModelSelectionUnlocked } from "../../sessions/model-overrides.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import type { PreparedInitialSessionContext } from "./session-initial-context.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

/** Only the native lifecycle worker can copy into an absent-to-created transcript. */
export function appendInitialSessionContextInTransaction(
  database: OpenClawAgentDatabase,
  params: {
    sessionKey: string;
    entry: SessionEntry;
    context: PreparedInitialSessionContext;
  },
): void {
  if (isMainThread) {
    throw new Error("Initial conversation context requires the native lifecycle worker.");
  }
  const { context, entry } = params;
  const sourceKey = normalizeStoreSessionKey(context.sourceSessionKey);
  const header = asOptionalRecord(context.events[0]);
  if (
    !sourceKey ||
    sourceKey === normalizeStoreSessionKey(params.sessionKey) ||
    context.sourceEntry.sessionId === entry.sessionId ||
    context.targetSessionId !== entry.sessionId ||
    entry.forkSource?.sessionKey !== sourceKey ||
    entry.forkSource?.sessionId !== context.sourceEntry.sessionId ||
    entry.forkSource?.entryId !== context.sourceThrough?.entryId ||
    header?.type !== "session" ||
    header.id !== entry.sessionId
  ) {
    throw new Error("Initial conversation context does not match its admitted source and target.");
  }
  assertCapturedSessionEntryReadSource(context.source, database);
  const source = readExactSessionEntryRow(database, sourceKey)?.entry;
  if (
    !source ||
    source.sessionId !== context.sourceEntry.sessionId ||
    source.lifecycleRevision !== context.sourceEntry.lifecycleRevision
  ) {
    throw new Error("Initial conversation context source changed before creation.");
  }
  assertModelSelectionUnlocked(source);
  // A busy source may append after preparation. Native prefix validation also
  // rejects navigation changes, not just generation changes or a lower sequence.
  validateSessionTranscriptContextInDatabase(
    database,
    {
      agentId: database.agentId,
      path: database.path,
      sessionKey: sourceKey,
      sessionId: source.sessionId,
    },
    { version: context.sourceVersion },
    "prefix",
  );
  if (context.sourceThrough) {
    validateSessionTranscriptContextInDatabase(
      database,
      {
        agentId: database.agentId,
        path: database.path,
        sessionKey: sourceKey,
        sessionId: source.sessionId,
      },
      { through: context.sourceThrough },
    );
  }
  // A missing visible row does not imply an unused transcript/window identity.
  const window = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_windows")
      .select("session_id")
      .where("session_id", "=", entry.sessionId),
  );
  const target = readTranscriptContextVersionInTransaction(database, entry.sessionId);
  if (window || target.generation !== null || target.rawSeq !== null) {
    throw new Error("Initial conversation context requires an unused target transcript.");
  }
  appendTranscriptEventsInTransaction(
    database,
    {
      agentId: database.agentId,
      path: database.path,
      sessionKey: params.sessionKey,
      sessionId: entry.sessionId,
    },
    context.events,
  );
}
