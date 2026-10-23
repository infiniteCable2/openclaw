import { isMainThread } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
} from "./conversation-knowledge.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { assertSessionConversationRootEntry } from "./session-conversation-admission.js";
import { resolveAgentConversationRootSessionKey } from "./session-conversation-root-key.js";
import type { PublishedSessionTranscriptArchive } from "./session-history-archive-pruning.types.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { transcriptEventJsonSql, transcriptEventNavigationSql } from "./transcript-payload.js";

/** Called after exact archive-row deletion, while the same transaction excludes restorers. */
export function retirePrunedConversationKnowledgeInTransaction(
  database: OpenClawAgentDatabase,
  archive: PublishedSessionTranscriptArchive,
): number {
  if (isMainThread || !database.db.isTransaction) {
    throw new Error("Conversation loss evidence requires the native archive worker transaction");
  }
  const db = getSessionKysely(database.db);
  const hasCopy = [
    db.selectFrom("transcript_events").select("session_id"),
    db.selectFrom("session_windows").select("session_id"),
    db.selectFrom("session_transcript_cold_archives").select("session_id"),
    db.selectFrom("session_transcript_archives").select("session_id"),
  ].some(
    (query) =>
      executeSqliteQuerySync(
        database.db,
        query.where("session_id", "=", archive.session_id).limit(1),
      ).rows.length > 0,
  );
  if (hasCopy) {
    return 0;
  }
  // Never infer an old source's topology from a reused source key. Each agent's
  // root has a deterministic owner, and each reference retains its own incarnation.
  const rootKey = resolveAgentConversationRootSessionKey({ agentId: database.agentId });
  const rootRow = readExactSessionEntryRow(database, rootKey);
  if (!rootRow) {
    if (
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("session_nodes").select("session_key").where("session_key", "=", rootKey),
      ).rows.length > 0
    ) {
      throw new Error("Conversation root could not be decoded before archive retirement");
    }
    // Ordinary native-mode agents need not have a conversation root.
    return 0;
  }
  const root = rootRow.entry;
  assertSessionConversationRootEntry(root, rootKey);
  if (
    sessionTranscriptIndexNeedsReconcile(database.db, root.sessionId) ||
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_transcript_cold_archives")
        .select("session_id")
        .where("session_id", "=", root.sessionId),
    ).rows.length > 0
  ) {
    throw new Error("Conversation root is not readable before archive retirement");
  }
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events as event")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select("event.seq")
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
  for (const row of rows) {
    const event = asOptionalRecord(JSON.parse(row.event_json));
    const details = asOptionalRecord(event?.details);
    const reference =
      readConversationKnowledgeReceipt(details) ?? readConversationUtteranceObservation(details);
    if (
      !event ||
      !details ||
      !reference ||
      reference.retirement ||
      reference.source.agentId !== database.agentId ||
      reference.source.sessionKey !== archive.session_key ||
      reference.source.sessionId !== archive.session_id ||
      reference.through.storePath !== database.path ||
      (reference.readRange?.through.generation ?? reference.through.generation) !==
        archive.generation
    ) {
      continue;
    }
    rewrites.push({
      event: {
        ...event,
        details: {
          ...details,
          retirement: {
            reason: "source-archive-pruned",
            generation: archive.generation,
            archiveSha256: archive.archive_sha256,
          },
        },
      },
      expectedEventJson: row.event_json,
      seq: row.seq,
    });
  }
  rewriteSqliteTranscriptEventRowsInTransaction(
    database,
    {
      agentId: database.agentId,
      path: database.path,
      sessionKey: rootKey,
      sessionId: root.sessionId,
    },
    rewrites,
  );
  return rewrites.length;
}
