import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { ensureConversationPublicationsSchema } from "../../state/openclaw-agent-conversation-publication-schema.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import type { ConversationPublicationRow } from "./conversation-publication.types.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { assertSessionConversationRootEntry } from "./session-conversation-admission.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { transcriptEventJsonSql, transcriptEventNavigationSql } from "./transcript-payload.js";

type ReadRange = NonNullable<ConversationKnowledgeReference["readRange"]>;
type ReferenceRange = Pick<
  ConversationKnowledgeReference,
  "through" | "privateAudience" | "readRange"
>;

function sameOccurrence(left: TranscriptEntryAnchor, right: TranscriptEntryAnchor): boolean {
  // Optional idempotency is not part of the persisted reference parser's identity.
  return (
    [
      "agentId",
      "storePath",
      "sessionKey",
      "sessionId",
      "entryId",
      "rawSeq",
      "effectiveParentId",
      "activeMessagePosition",
    ] as const
  ).every((field) => left[field] === right[field]);
}

/** The exact-row writer proves that every byte preceding its first touched row is unchanged. */
export function deriveConversationKnowledgeReadRange(params: {
  reference: ReferenceRange;
  previousGeneration: string;
  firstChangedSeq: number;
  through: TranscriptEntryAnchor | undefined;
  admission?: TranscriptEntryAnchor;
}): ReadRange | undefined {
  const { reference, through, admission } = params;
  const previous = reference.readRange ?? {
    through: reference.through,
    admission: reference.privateAudience?.admission,
  };
  if (
    !Number.isSafeInteger(params.firstChangedSeq) ||
    params.firstChangedSeq < 0 ||
    !through ||
    previous.through.generation !== params.previousGeneration ||
    reference.through.rawSeq >= params.firstChangedSeq ||
    !sameOccurrence(previous.through, reference.through) ||
    !sameOccurrence(through, reference.through) ||
    through.generation === params.previousGeneration
  ) {
    return undefined;
  }
  if (reference.privateAudience) {
    const original = reference.privateAudience.admission;
    if (
      !admission ||
      !previous.admission ||
      previous.admission.generation !== params.previousGeneration ||
      admission.generation !== through.generation ||
      !sameOccurrence(previous.admission, original) ||
      !sameOccurrence(admission, original) ||
      original.rawSeq > reference.through.rawSeq
    ) {
      return undefined;
    }
    return { through, admission };
  }
  return previous.admission || admission ? undefined : { through };
}

/** Worker-only, within the source rewrite's transaction; never retrospective requalification. */
export function renewConversationKnowledgeAfterExactRewriteInTransaction(params: {
  database: OpenClawAgentDatabase;
  scope: ResolvedTranscriptScope;
  previousGeneration: string;
  firstChangedSeq: number;
  /** Exact writer proof: named operational annotations alone do not change observed dialogue. */
  readFirstObservationChangedSeq?(): number;
  rewriteRootRows(
    scope: ResolvedTranscriptScope,
    rows: Array<{ event: TranscriptEvent; expectedEventJson: string; seq: number }>,
  ): void;
}): void {
  const { database, scope } = params;
  if (isMainThread) {
    throw new Error("Conversation continuity SQL requires the native transcript worker");
  }
  if (!database.db.isTransaction) {
    throw new Error("Conversation continuity requires its original rewrite transaction");
  }
  const source = readSessionEntryRow(database, scope.sessionKey)?.entry;
  const topology = source?.conversationTopology;
  if (
    source?.sessionId !== scope.sessionId ||
    !source.lifecycleRevision ||
    source.incognito ||
    topology?.role !== "branch" ||
    topology.rootSessionKey === scope.sessionKey ||
    sessionTranscriptIndexNeedsReconcile(database.db, scope.sessionId)
  ) {
    return;
  }
  const root = readSessionEntryRow(database, topology.rootSessionKey)?.entry;
  if (
    root?.sessionId !== topology.rootSessionId ||
    root.lifecycleRevision !== topology.rootSessionLifecycleRevision ||
    sessionTranscriptIndexNeedsReconcile(database.db, root.sessionId)
  ) {
    return;
  }
  assertSessionConversationRootEntry(root, topology.rootSessionKey);
  const rootScope = { ...scope, sessionKey: topology.rootSessionKey, sessionId: root.sessionId };
  let firstObservationChangedSeq: number | undefined;
  const renew = (
    reference: ReferenceRange &
      Pick<ConversationKnowledgeReference, "source"> & { kind?: "utterance-observation" },
  ) => {
    if (
      reference.source.agentId !== scope.agentId ||
      reference.source.sessionKey !== scope.sessionKey ||
      reference.source.sessionId !== scope.sessionId ||
      reference.source.lifecycleRevision !== source.lifecycleRevision ||
      (reference.privateAudience && source.publicShare !== undefined)
    ) {
      return undefined;
    }
    const read = (anchor: TranscriptEntryAnchor) =>
      readActiveTranscriptEntryAnchorInTransaction({
        database,
        resolved: scope,
        entryId: anchor.entryId,
      });
    return deriveConversationKnowledgeReadRange({
      reference,
      previousGeneration: params.previousGeneration,
      firstChangedSeq:
        reference.kind === "utterance-observation"
          ? (firstObservationChangedSeq ??=
              params.readFirstObservationChangedSeq?.() ?? params.firstChangedSeq)
          : params.firstChangedSeq,
      through: read(reference.through),
      admission: reference.privateAudience && read(reference.privateAudience.admission),
    });
  };
  // Only this enrolled root's active reference rows are decoded, never other roots or dialogue.
  const db = getSessionKysely(database.db);
  const references = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events as event")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select(["event.seq"])
      .select(transcriptEventJsonSql(database.db, "event").as("event_json"))
      .where("event.session_id", "=", root.sessionId)
      .where(
        (eb) =>
          eb.fn<string>("json_extract", [
            transcriptEventNavigationSql("event"),
            eb.val("$.customType"),
          ]),
        "in",
        [CONVERSATION_KNOWLEDGE_REPORT, CONVERSATION_UTTERANCE_REPORT],
      )
      .orderBy("event.seq"),
  ).rows;
  const rewrites: Array<{ event: TranscriptEvent; expectedEventJson: string; seq: number }> = [];
  for (const row of references) {
    const event = asOptionalRecord(JSON.parse(row.event_json));
    const details = asOptionalRecord(event?.details);
    const reference =
      readConversationKnowledgeReceipt(details) ?? readConversationUtteranceObservation(details);
    const readRange = reference && renew(reference);
    if (event && details && readRange) {
      rewrites.push({
        event: { ...event, details: { ...details, readRange } },
        expectedEventJson: row.event_json,
        seq: row.seq,
      });
    }
  }
  if (rewrites.length > 0) {
    // The ordinary exact-row owner rotates the root generation and invalidates projections.
    // The root is not a branch, so this cannot recursively renew references.
    params.rewriteRootRows(rootScope, rewrites);
  }
  const table = "session_conversation_publications";
  ensureConversationPublicationsSchema(database.db);
  const journal = getNodeSqliteKysely<Pick<DB, typeof table>>(database.db);
  const pending = executeSqliteQuerySync(
    database.db,
    journal
      .selectFrom(table)
      .select(["publication_id", "payload_json"])
      .where("session_key", "=", scope.sessionKey)
      .where("session_id", "=", scope.sessionId)
      .where("lifecycle_revision", "=", source.lifecycleRevision),
  ).rows;
  for (const row of pending) {
    // SAFETY: The private payload is issued only by the native publication transaction.
    const payload = JSON.parse(row.payload_json) as Pick<
      ConversationPublicationRow,
      "intent" | "anchor" | "readRange"
    >;
    if (
      !isDeepStrictEqual(payload.intent.root, {
        sessionKey: topology.rootSessionKey,
        sessionId: root.sessionId,
        lifecycleRevision: root.lifecycleRevision,
      })
    ) {
      continue;
    }
    const readRange = renew({
      source: { agentId: scope.agentId, ...payload.intent.source },
      through: payload.anchor,
      privateAudience: payload.intent.privateAudience,
      readRange: payload.readRange,
      ...(payload.intent.kind === "utterance-observation" ? { kind: payload.intent.kind } : {}),
    });
    if (readRange) {
      executeSqliteQuerySync(
        database.db,
        journal
          .updateTable(table)
          .set({ payload_json: JSON.stringify({ ...payload, readRange }) })
          .where("publication_id", "=", row.publication_id)
          .where("payload_json", "=", row.payload_json),
      );
    }
  }
}
