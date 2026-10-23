import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { hasErrnoCode } from "../../infra/errno.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { retirePrunedConversationKnowledgeInTransaction } from "./conversation-knowledge-retirement.worker.js";
import { readReferencedSessionIds } from "./session-accessor.sqlite-lifecycle-state.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type {
  PublishedSessionTranscriptArchive,
  SessionArchivePruningRead,
  SessionArchiveRetentionDelete,
  SessionLegacyArchiveRemovalResult,
  SessionPublishedArchiveDelete,
} from "./session-history-archive-pruning.types.js";

const knowledgeLog = createSubsystemLogger("sessions/conversation-knowledge");

function archiveFileIsAbsent(directory: string, row: PublishedSessionTranscriptArchive): boolean {
  const archivePath = path.resolve(directory, row.archive_name);
  if (path.dirname(archivePath) !== directory || path.basename(archivePath) !== row.archive_name) {
    return false;
  }
  try {
    fs.lstatSync(archivePath);
    return false;
  } catch (error) {
    // Permission errors and other uncertain filesystem outcomes are not loss evidence.
    return hasErrnoCode(error, "ENOENT");
  }
}

function deleteExactArchiveInTransaction(
  database: OpenClawAgentDatabase,
  row: PublishedSessionTranscriptArchive,
): boolean {
  const deletion = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .deleteFrom("session_transcript_archives")
      .where("session_id", "=", row.session_id)
      .where("generation", "=", row.generation)
      .where("archive_name", "=", row.archive_name)
      .where("archive_sha256", "=", row.archive_sha256)
      .where("created_at", "=", row.created_at)
      .where("encoding", "=", row.encoding)
      .where("reason", "=", row.reason)
      .where("session_key", "=", row.session_key)
      .where("published_at", "=", row.published_at),
  );
  return deletion.numAffectedRows === 1n;
}

function retireArchiveKnowledge(
  database: OpenClawAgentDatabase,
  row: PublishedSessionTranscriptArchive,
) {
  // Existing synchronous Doctor/SDK maintenance keeps its conservative legacy behavior;
  // never add root metadata queries or writes on the Gateway main thread.
  return isMainThread ? 0 : retirePrunedConversationKnowledgeInTransaction(database, row);
}

function logRetiredArchiveKnowledge(count: number, archive: PublishedSessionTranscriptArchive) {
  if (count > 0) {
    knowledgeLog.info("Pruned source references retired", {
      count,
      source: redactIdentifier(JSON.stringify([archive.session_id, archive.generation])),
    });
  }
}

export function readSessionArchivePruningInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  limit = 1,
): PublishedSessionTranscriptArchive[] {
  if (!tableExists(database.db, "session_transcript_archives")) {
    return [];
  }
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_transcript_archives")
      .select([
        "archive_name",
        "archive_sha256",
        "created_at",
        "encoding",
        "generation",
        "published_at",
        "reason",
        "session_id",
        "session_key",
      ])
      .where("published_at", "is not", null)
      .$narrowType<{ published_at: number }>()
      .orderBy("created_at", "asc")
      .orderBy("session_id", "asc")
      .orderBy("generation", "asc")
      .limit(limit),
  ).rows;
  return rows.map((row) => Object.assign({}, row));
}

export function readSessionArchivePruningInWorker(
  request: SessionArchivePruningRead,
): PublishedSessionTranscriptArchive[] {
  const identity = `file:${request.expectedIdentity.physicalIdentity}`;
  assertExistingDatabaseIdentity(request.database.path, identity);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const current = readOpenClawAgentDatabaseIdentity(database);
      if (
        current.identity !== request.expectedIdentity.physicalIdentity ||
        current.filename !== request.expectedIdentity.nativeLocation
      ) {
        throw new Error("SQLite archive pruning database owner changed");
      }
      const value = readSessionArchivePruningInDatabase(database, request.limit);
      assertExistingDatabaseIdentity(request.database.path, identity);
      return value;
    },
    { ...request.database, env: request.env },
  );
  if (!result.found) {
    throw new Error(`SQLite archive pruning cannot read its database: ${result.reason}`);
  }
  return result.value;
}

export function pruneSessionArchivesByRetentionInDatabase(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: SessionArchiveRetentionDelete,
  admit: (stage: "transaction" | "commit") => void,
): number {
  const result = runOpenClawAgentWriteTransaction(
    (transactionDb) => {
      if (transactionDb.db !== database.db) {
        throw new Error("SQLite archive pruning lost its database owner");
      }
      admit("transaction");
      const referenced = readReferencedSessionIds(
        transactionDb,
        undefined,
        input.candidates.map((row) => row.session_id),
      );
      const directory = path.resolve(input.archiveDirectory);
      const retired: Array<{ count: number; archive: PublishedSessionTranscriptArchive }> = [];
      let removed = 0;
      for (const row of input.candidates) {
        if (referenced.has(row.session_id) || !archiveFileIsAbsent(directory, row)) {
          continue;
        }
        // Selection can wait behind publication or restore; stale rows simply wait for another sweep.
        if (deleteExactArchiveInTransaction(transactionDb, row)) {
          removed++;
          retired.push({ count: retireArchiveKnowledge(transactionDb, row), archive: row });
        }
      }
      admit("commit");
      return { removed, retired };
    },
    options,
    { operationLabel: "session.archive.prune-retention" },
  );
  result.retired.forEach(({ count, archive }) => logRetiredArchiveKnowledge(count, archive));
  return result.removed;
}

function removeLegacyArchiveFile(
  filePath: string,
  admitCommit: () => void,
): SessionLegacyArchiveRemovalResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    admitCommit();
    return "failed";
  }
  if (!stat.isFile()) {
    admitCommit();
    return "failed";
  }
  // Unlink cannot roll back; authorize it while the transaction still excludes peers.
  admitCommit();
  try {
    fs.unlinkSync(filePath);
    return "removed";
  } catch {
    return "failed";
  }
}

export function removeLegacySessionArchiveInDatabase(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  filePath: string,
  admit: (stage: "transaction" | "commit") => void,
): SessionLegacyArchiveRemovalResult {
  return runOpenClawAgentWriteTransaction(
    (transactionDb) => {
      if (transactionDb.db !== database.db) {
        throw new Error("SQLite archive pruning lost its database owner");
      }
      admit("transaction");
      const db = getSessionKysely(transactionDb.db);
      const owned =
        tableExists(transactionDb.db, "session_transcript_archives") &&
        executeSqliteQuerySync(
          transactionDb.db,
          db
            .selectFrom("session_transcript_archives")
            .select("archive_name")
            .where("archive_name", "=", path.basename(filePath))
            .limit(1),
        ).rows.length > 0;
      if (owned) {
        admit("commit");
        return "preserved";
      }
      return removeLegacyArchiveFile(filePath, () => admit("commit"));
    },
    options,
    { operationLabel: "session.archive.remove-legacy" },
  );
}

export function deletePublishedSessionArchiveInDatabase(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: SessionPublishedArchiveDelete,
  admit: (stage: "transaction" | "commit") => void,
): void {
  const row = input.archive;
  const retired = runOpenClawAgentWriteTransaction(
    (transactionDb) => {
      if (transactionDb.db !== database.db) {
        throw new Error("SQLite archive pruning lost its database owner");
      }
      admit("transaction");
      if (!archiveFileIsAbsent(path.resolve(input.archiveDirectory), row)) {
        throw new Error("SQLite session archive file removal is not confirmed; retry cleanup.");
      }
      // A peer or cold reopen may change publication while unlink is in flight.
      if (!deleteExactArchiveInTransaction(transactionDb, row)) {
        throw new Error("SQLite session archive changed during pruning; retry cleanup.");
      }
      const count = retireArchiveKnowledge(transactionDb, row);
      admit("commit");
      return count;
    },
    options,
    { operationLabel: "session.archive.delete-published" },
  );
  logRetiredArchiveKnowledge(retired, row);
}
