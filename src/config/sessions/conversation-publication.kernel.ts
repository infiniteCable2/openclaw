import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { ensureConversationPublicationsSchema } from "../../state/openclaw-agent-conversation-publication-schema.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  conversationKnowledgeOrigin,
  isConversationUtteranceObservation,
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
} from "./conversation-knowledge.js";
import type {
  ConversationPublicationAcceptance,
  ConversationPublicationIntent,
  ConversationPublicationRow,
} from "./conversation-publication.types.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import { assertSessionConversationRootEntry } from "./session-conversation-admission.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

const TABLE = "session_conversation_publications";
type JournalDatabase = Pick<DB, typeof TABLE>;
type StoredRow = {
  publication_id: string;
  payload_json: string;
  state: string;
  attempt_count: number;
  next_attempt_at: number;
  last_failure: string | null;
};

function journal(database: OpenClawAgentDatabase) {
  ensureConversationPublicationsSchema(database.db);
  return getNodeSqliteKysely<JournalDatabase>(database.db);
}

function requireTransaction(database: OpenClawAgentDatabase) {
  if (!database.db.isTransaction) {
    throw new Error("Conversation publication requires the original native transaction");
  }
}

function assertEnrollment(database: OpenClawAgentDatabase, intent: ConversationPublicationIntent) {
  const source = readSessionEntryRow(database, intent.source.sessionKey)?.entry;
  const root = readSessionEntryRow(database, intent.root.sessionKey)?.entry;
  assertSessionConversationRootEntry(root, intent.root.sessionKey);
  if (
    source?.sessionId !== intent.source.sessionId ||
    source.lifecycleRevision !== intent.source.lifecycleRevision ||
    source.incognito ||
    source.conversationTopology?.role !== "branch" ||
    source.conversationTopology.rootSessionKey !== intent.root.sessionKey ||
    source.conversationTopology.rootSessionId !== intent.root.sessionId ||
    source.conversationTopology.rootSessionLifecycleRevision !== intent.root.lifecycleRevision ||
    root.sessionId !== intent.root.sessionId ||
    root.lifecycleRevision !== intent.root.lifecycleRevision ||
    (intent.privateAudience && source.publicShare !== undefined)
  ) {
    throw new Error("Conversation publication enrollment changed");
  }
  return source;
}

function decode(row: StoredRow): ConversationPublicationRow {
  if (row.state !== "candidate" && row.state !== "ready" && row.state !== "blocked") {
    throw new Error("Invalid conversation publication state");
  }
  // SAFETY: Only the transaction-owned receipt validators below write this private payload.
  const { intent, anchor } = JSON.parse(row.payload_json) as Pick<
    ConversationPublicationRow,
    "intent" | "anchor"
  >;
  return {
    id: row.publication_id,
    intent,
    anchor,
    state: row.state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_failure ? { lastFailure: row.last_failure } : {}),
  };
}

/** Only the canonical fresh-message append invokes this; replay cannot invent missing provenance. */
export function captureConversationPublicationInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  input: ConversationPublicationIntent,
  anchor: TranscriptEntryAnchor | undefined,
  message: unknown,
): string {
  requireTransaction(database);
  if (
    !anchor ||
    input.version !== 1 ||
    scope.sessionKey !== input.source.sessionKey ||
    scope.sessionId !== input.source.sessionId ||
    anchor.agentId !== scope.agentId ||
    anchor.sessionKey !== scope.sessionKey ||
    anchor.sessionId !== scope.sessionId ||
    (input.privateAudience?.admission === "self" && input.kind !== "utterance-observation")
  ) {
    throw new Error("Conversation publication lacks its exact original message");
  }
  const intent: ConversationPublicationRow["intent"] = {
    ...structuredClone(input),
    privateAudience: input.privateAudience
      ? {
          participant: structuredClone(input.privateAudience.participant),
          admission: structuredClone(
            input.privateAudience.admission === "self" ? anchor : input.privateAudience.admission,
          ),
        }
      : undefined,
  };
  const sourceEntry = assertEnrollment(database, intent);
  const source = { agentId: scope.agentId, ...intent.source };
  const origin = conversationKnowledgeOrigin(
    source,
    intent.kind === "utterance-observation" ? intent.kind : undefined,
  );
  const candidate = {
    version: 1,
    sourceMode: intent.sourceMode,
    source,
    origin,
    through: anchor,
    privateAudience: intent.privateAudience,
    observed: intent.observed,
  } as const;
  const persisted = asOptionalRecord(message);
  if (intent.kind === "completed-turn") {
    if (
      !sourceEntry.activeWriterRunId ||
      !readConversationKnowledgeReceipt({ ...candidate, runId: intent.runId }) ||
      persisted?.role !== "assistant" ||
      persisted.stopReason !== "stop" ||
      persisted.endTurn === false ||
      readSessionTranscriptRunId(message) !== intent.runId
    ) {
      throw new Error("Conversation publication candidate is not its admitted terminal");
    }
  } else {
    const receipt = readConversationUtteranceObservation({
      ...candidate,
      kind: intent.kind,
      role: intent.role,
    });
    // This bounded append validates only its own occurrence. The receipt parser
    // validates audience anchor shape; publication rechecks its full source range.
    if (
      !receipt ||
      !isConversationUtteranceObservation({ ...receipt, privateAudience: undefined }, [
        {
          type: "message",
          id: anchor.entryId,
          message,
        },
      ])
    ) {
      throw new Error("Conversation publication is not its original voice occurrence");
    }
  }
  const id = sha256Hex(JSON.stringify([origin, anchor.generation, anchor.entryId]));
  const payload = {
    intent,
    anchor: structuredClone(anchor),
    admittedWriterRunId: sourceEntry.activeWriterRunId ?? null,
  };
  const json = JSON.stringify(payload);
  const db = journal(database);
  const existing = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom(TABLE).select("payload_json").where("publication_id", "=", id),
  );
  if (existing) {
    if (!isDeepStrictEqual(JSON.parse(existing.payload_json), JSON.parse(json))) {
      throw new Error("Conversation publication identity conflicts with original provenance");
    }
    return id;
  }
  executeSqliteQuerySync(
    database.db,
    db.insertInto(TABLE).values({
      publication_id: id,
      session_id: scope.sessionId,
      session_key: scope.sessionKey,
      lifecycle_revision: intent.source.lifecycleRevision,
      origin,
      entry_id: anchor.entryId,
      run_id: intent.kind === "completed-turn" ? intent.runId : null,
      state: intent.kind === "completed-turn" ? "candidate" : "ready",
      payload_json: json,
      created_at: Date.now(),
    }),
  );
  return id;
}

/** Settlement can select only a previously captured exact candidate, never the latest assistant. */
export function acceptConversationPublicationInTransaction(
  database: OpenClawAgentDatabase,
  input: ConversationPublicationAcceptance,
): string | undefined {
  requireTransaction(database);
  const db = journal(database);
  let entryId = input.entryId;
  if (input.idempotencyKey) {
    const found = readTranscriptMessageByScopedIdempotencyKey(
      database,
      {
        agentId: database.agentId,
        path: database.path,
        sessionKey: input.sessionKey,
        sessionId: input.sessionId,
      },
      input.idempotencyKey,
      "scan-assistant",
    );
    if (
      !found ||
      readSessionTranscriptRunId(found.message) !== input.runId ||
      (entryId !== undefined && found.messageId !== entryId)
    ) {
      return undefined;
    }
    entryId = found.messageId;
  }
  if (!entryId) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom(TABLE)
      .selectAll()
      .where("session_key", "=", input.sessionKey)
      .where("session_id", "=", input.sessionId)
      .where("lifecycle_revision", "=", input.lifecycleRevision)
      .where("entry_id", "=", entryId)
      .where("run_id", "=", input.runId),
  );
  if (!row || row.state === "blocked") {
    return undefined;
  }
  const decoded = decode(row);
  const source = assertEnrollment(database, decoded.intent);
  const payload: unknown = JSON.parse(row.payload_json);
  const admittedWriterRunId = asOptionalRecord(payload)?.admittedWriterRunId;
  if (
    typeof admittedWriterRunId !== "string" ||
    !admittedWriterRunId ||
    source.activeWriterRunId !== admittedWriterRunId
  ) {
    throw new Error("Conversation publication lost its original native writer");
  }
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable(TABLE)
      .set({ state: "blocked", last_failure: "superseded-terminal" })
      .where("session_id", "=", input.sessionId)
      .where("run_id", "=", input.runId)
      .where("state", "=", "candidate")
      .where("publication_id", "!=", row.publication_id),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable(TABLE)
      .set({ state: "ready" })
      .where("publication_id", "=", row.publication_id)
      .where("state", "=", "candidate"),
  );
  return row.publication_id;
}

function readyHeads(database: OpenClawAgentDatabase) {
  return journal(database)
    .selectFrom(`${TABLE} as current`)
    .selectAll("current")
    .where("current.state", "=", "ready")
    .where((expression) =>
      expression.not(
        expression.exists(
          expression
            .selectFrom(`${TABLE} as earlier`)
            .select("earlier.publication_id")
            .whereRef("earlier.origin", "=", "current.origin")
            .where("earlier.state", "=", "ready")
            .whereRef("earlier.capture_sequence", "<", "current.capture_sequence"),
        ),
      ),
    );
}

export function readConversationPublicationReadyHeads(
  database: OpenClawAgentDatabase,
  input: { now: number; limit: number },
): ConversationPublicationRow[] {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 128 ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0
  ) {
    throw new Error("Invalid bounded conversation publication request");
  }
  return executeSqliteQuerySync(
    database.db,
    readyHeads(database)
      .where("current.next_attempt_at", "<=", input.now)
      .orderBy("current.capture_sequence")
      .limit(input.limit),
  ).rows.map(decode);
}

export function nextConversationPublicationAttempt(database: OpenClawAgentDatabase) {
  return executeSqliteQueryTakeFirstSync(
    database.db,
    readyHeads(database).orderBy("current.next_attempt_at").limit(1),
  )?.next_attempt_at;
}

/** Root publication is already idempotently confirmed when its pending journal row is removed. */
export function acknowledgeConversationPublication(database: OpenClawAgentDatabase, id: string) {
  requireTransaction(database);
  executeSqliteQuerySync(
    database.db,
    journal(database)
      .deleteFrom(TABLE)
      .where("publication_id", "=", id)
      .where("state", "=", "ready"),
  );
}

export function failConversationPublication(
  database: OpenClawAgentDatabase,
  input: { id: string; errorCode: string; nextAttemptAt?: number; blocked: boolean },
) {
  requireTransaction(database);
  if (
    !/^[a-z][a-z0-9-]{0,79}$/.test(input.errorCode) ||
    (!input.blocked && (!Number.isSafeInteger(input.nextAttemptAt) || input.nextAttemptAt! < 0))
  ) {
    throw new Error("Invalid content-free conversation publication failure");
  }
  executeSqliteQuerySync(
    database.db,
    journal(database)
      .updateTable(TABLE)
      .set((eb) => ({
        state: input.blocked ? "blocked" : "ready",
        last_failure: input.errorCode,
        next_attempt_at: input.nextAttemptAt ?? 0,
        attempt_count: eb("attempt_count", "+", 1),
      }))
      .where("publication_id", "=", input.id)
      .where("state", "=", "ready"),
  );
}

export function readConversationPublicationStats(database: OpenClawAgentDatabase) {
  return executeSqliteQuerySync(
    database.db,
    journal(database)
      .selectFrom(TABLE)
      .select((eb) => ["state", eb.fn.countAll<number>().as("count")])
      .groupBy("state"),
  ).rows;
}
