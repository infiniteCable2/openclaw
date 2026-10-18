import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { assertModelSelectionUnlocked } from "../../sessions/model-overrides.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { SessionEntry } from "./types.js";

/** Native-prepared snapshot data; the caller must separately retain live read authority. */
export type PreparedInitialSessionContext = {
  source: CapturedSessionEntryReadSource & { databaseIdentity: string };
  sourceSessionKey: string;
  sourceEntry: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  /** Stability watermark of the captured source, not the endpoint of copied knowledge. */
  sourceVersion: SessionTranscriptContextVersion;
  /** Exact completed endpoint; pending source suffixes are not inherited or acknowledged. */
  sourceThrough?: TranscriptEntryAnchor;
  targetSessionId: string;
  events: readonly TranscriptEvent[];
};

/** Copied bytes must name the same donor covered by the retained native read predicates. */
export function assertInitialSessionContextReadSource(
  context: PreparedInitialSessionContext,
  sources: readonly SessionSourcePredicate[] | undefined,
): void {
  const key = normalizeStoreSessionKey(context.sourceSessionKey);
  const matching = sources?.some(
    (source) =>
      key &&
      normalizeStoreSessionKey(source.sessionKey) === key &&
      source.source.agentId === context.source.agentId &&
      source.source.path === context.source.path &&
      source.source.databaseIdentity === context.source.databaseIdentity &&
      source.source.databaseBirthtime === context.source.databaseBirthtime &&
      source.expected?.sessionId === context.sourceEntry.sessionId &&
      source.expected?.lifecycleRevision === context.sourceEntry.lifecycleRevision &&
      source.fields.includes("sessionId") &&
      source.fields.includes("lifecycleRevision") &&
      source.fields.includes("createdActor") &&
      source.fields.includes("visibility") &&
      source.fields.includes("incognito"),
  );
  if (!matching) {
    throw new Error(
      "Initial conversation context requires matching prepared donor read authority.",
    );
  }
}

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
