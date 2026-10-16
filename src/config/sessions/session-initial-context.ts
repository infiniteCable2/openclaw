import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { assertModelSelectionUnlocked } from "../../sessions/model-overrides.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

/** Native-prepared snapshot data; the caller must separately retain live read authority. */
export type PreparedInitialSessionContext = {
  source: CapturedSessionEntryReadSource & { databaseIdentity: string };
  sourceSessionKey: string;
  sourceEntry: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  sourceVersion: SessionTranscriptContextVersion;
  targetSessionId: string;
  events: readonly TranscriptEvent[];
};

/** Called only for an absent-to-created upsert inside the native lifecycle transaction. */
export function appendInitialSessionContextInTransaction(
  database: OpenClawAgentDatabase,
  params: {
    sessionKey: string;
    entry: SessionEntry;
    context: PreparedInitialSessionContext;
  },
): void {
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
  const version = readTranscriptContextVersionInTransaction(database, source.sessionId);
  if (
    version.generation !== context.sourceVersion.generation ||
    version.rawSeq !== context.sourceVersion.rawSeq ||
    version.updatedAt !== context.sourceVersion.updatedAt
  ) {
    throw new Error("Initial conversation context snapshot changed before creation.");
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
