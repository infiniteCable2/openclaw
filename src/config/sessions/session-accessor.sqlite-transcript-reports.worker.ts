import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import type { CliHistoryWriterFacts } from "./cli-history-boundary.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { advanceCliHistoryBoundaryRangeInTransaction } from "./session-accessor.sqlite-cli-history-boundary.js";
import type {
  SessionTranscriptWriteScope,
  SessionTranscriptContextVersion,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import {
  appendAbortedSessionTranscriptPartialInTransaction,
  appendSelectedTranscriptReportInTransaction,
  prepareTranscriptReportSelection,
} from "./session-accessor.sqlite-transcript-reports.kernel.js";
import type {
  AbortedSessionTranscriptPartialResult,
  PreparedTranscriptReport,
  TranscriptReportCommit,
  TranscriptReportWorkerOperations,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { requestSessionEntryCurrentAdmission } from "./session-entry-current-admission.worker.js";
import type { SessionEntryCurrentSource } from "./session-entry-current.types.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";

export type TranscriptReportWorkerTarget = {
  resolved: Omit<ResolvedTranscriptScope, "env">;
  cliWriter?: CliHistoryWriterFacts;
  sessionEntryCurrentSource?: SessionEntryCurrentSource;
  sourcePredicates?: SessionSourcePredicate[];
  fence: Pick<SessionTranscriptWriteScope, "expectedLifecycleRevision" | "expectedWriterRunId">;
};

/** Domain binding borrows the existing SQLite broker's canonical writer. */
export function bindSqliteWorkerBackend(
  target: TranscriptReportWorkerTarget,
  context: {
    database: DatabaseSync;
    databasePath: string;
    admit(
      stage: "transaction" | "commit",
      requestAdmission?: AgentDatabaseAdmissionRestriction,
    ): void;
  },
): SqliteWorkerBackend<TranscriptReportWorkerOperations> {
  const { fence } = target;
  const resolved = { ...target.resolved, env: getSqliteWorkerStateContext().environment };
  const options = toDatabaseOptions(resolved);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const sameOwner = context.database.location()
    ? readDatabasePathIdentitySync(pathname).canonicalPath === context.databasePath
    : pathname === context.databasePath &&
      getOpenClawAgentDatabaseIfOpen(options)?.db === context.database;
  if (!sameOwner) {
    throw new Error("Transcript report target changed its database owner");
  }
  resolved.path = context.databasePath;
  options.path = context.databasePath;
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database || database.db !== context.database || database.path !== context.databasePath) {
    throw new Error("Transcript report lost its canonical database owner");
  }
  const admit = (stage: "transaction" | "commit") => {
    const predicates = target.sourcePredicates;
    for (const predicate of predicates ?? []) {
      // Native source predicates are atomic only inside this same physical store.
      assertCapturedSessionEntryReadSource(predicate.source, database);
    }
    const validation = predicates && readSessionSourceValidation(database, predicates);
    context.admit(stage, (request, dispatch) => {
      if (validation && !isRecord(request.facts)) {
        throw new Error("Transcript report admission omitted its database facts");
      }
      requestSessionEntryCurrentAdmission(
        target.sessionEntryCurrentSource,
        validation
          ? {
              ...request,
              facts: {
                ...(isRecord(request.facts) ? request.facts : {}),
                reportSourceValidation: validation,
              },
            }
          : request,
        { database },
        dispatch,
      );
    });
  };
  let closed = false;
  const assertOpen = () => {
    if (closed || !database.db.isOpen) {
      throw new Error("Transcript report domain is closed");
    }
    assertTransactionUsable(database.db);
  };
  let lifecycleRevision: string | undefined;
  const readRefusal = () => {
    const entry = readSessionEntryRow(database, resolved.sessionKey, "list")?.entry;
    lifecycleRevision = entry?.lifecycleRevision;
    return resolveTranscriptAppendRefusal(entry, resolved, { ...resolved, ...fence });
  };
  const deferredContextAdmission = new Error("Transcript report context admission deferred");
  const runReportTransaction = (
    operation: (
      current: OpenClawAgentDatabase,
    ) => Result<TranscriptReportCommit, TranscriptAppendRefusal>,
  ): Result<TranscriptReportCommit, TranscriptAppendRefusal> => {
    try {
      return runOpenClawAgentWriteTransaction(operation, options, {
        operationLabel: "session.transcript.report",
      });
    } catch (error) {
      if (error !== deferredContextAdmission) {
        throw error;
      }
      // The native transaction has rolled back the provisional header together
      // with its staged publications. Deferral must still prove NO WRITE.
      assertOpen();
      if (database.db.isTransaction) {
        throw new Error("Deferred transcript report left a transaction open", { cause: error });
      }
      return ok({ committed: false, projectionNeedsReconcile: false, deferred: true });
    }
  };
  let prepared:
    | {
        facts: PreparedTranscriptReport;
        version: SessionTranscriptContextVersion;
      }
    | undefined;
  return {
    execute(command) {
      assertOpen();
      if (command.type === "prepare") {
        return runSqliteDeferredTransactionSync<
          Result<PreparedTranscriptReport, TranscriptAppendRefusal>
        >(database.db, () => {
          prepared = undefined;
          if (target.sourcePredicates) {
            admit("transaction");
          }
          const refusal = readRefusal();
          if (refusal) {
            return err(refusal);
          }
          prepared = {
            facts: prepareTranscriptReportSelection(database, resolved, command.input),
            version: readTranscriptContextVersionInTransaction(database, resolved.sessionId),
          };
          return ok(prepared.facts);
        });
      }
      return runReportTransaction((current) => {
        if (current.db !== database.db) {
          throw new Error("Transcript report lost its canonical database owner");
        }
        admit("transaction");
        const refusal = readRefusal();
        if (refusal) {
          admit("commit");
          return err(refusal);
        }
        const firstSeq = target.cliWriter
          ? (readTranscriptContextVersionInTransaction(database, resolved.sessionId).rawSeq ?? -1) +
            1
          : undefined;
        let projectionNeedsReconcile = false;
        const projection = {
          scheduleProjectionReconcile: false as const,
          onProjectionReconcileNeeded: () => {
            projectionNeedsReconcile = true;
          },
        };
        let abortedPartial: AbortedSessionTranscriptPartialResult | undefined;
        let transcriptChanged = false;
        if (command.type === "abortedPartial") {
          abortedPartial = appendAbortedSessionTranscriptPartialInTransaction(
            database,
            resolved,
            command.input,
            command.input.preparedMessage,
            projection,
          );
        } else if (command.type === "assistant") {
          const facts = prepareTranscriptReportSelection(database, resolved, {
            kind: "assistant",
            responseId: command.input.message.responseId,
          });
          if (!facts.suppressed) {
            transcriptChanged = appendSelectedTranscriptReportInTransaction(
              database,
              resolved,
              facts.appendParentId,
              command.input,
              projection,
              command.input.preparedMessage,
            );
          }
        } else {
          const plan = prepared;
          prepared = undefined;
          if (!plan || plan.facts.suppressed) {
            throw new Error("Transcript report append requires its prepared selection");
          }
          const currentVersion = readTranscriptContextVersionInTransaction(
            database,
            resolved.sessionId,
          );
          if (!isDeepStrictEqual(currentVersion, plan.version)) {
            admit("commit");
            return ok({ committed: false, projectionNeedsReconcile: false });
          }
          const limits = command.input.preserveContextLimits;
          if (limits) {
            // A first-turn recipient has no transcript yet. Initialize it
            // under this same writer and count its real header in the budget.
            // A deferred report rolls this initialization back atomically.
            ensureTranscriptHeader(database, resolved, undefined, projection);
            const snapshot = readSessionTranscriptBoundedActiveContextCore(resolved, {
              ...limits,
              resolvedScope: resolved,
            });
            const additionalBytes = Buffer.byteLength(command.input.eventJson, "utf8") + 1;
            // Header and injected boundaries remain counted. The event count is
            // deliberately conservative so no currently hydrated row is displaced.
            if (
              snapshot.events.length === 0 ||
              snapshot.serializedBytes + additionalBytes > limits.maxBytes ||
              snapshot.events.length + 1 > limits.maxEvents
            ) {
              admit("commit");
              throw deferredContextAdmission;
            }
          }
          transcriptChanged = appendSelectedTranscriptReportInTransaction(
            database,
            resolved,
            plan.facts.appendParentId,
            command.input,
            projection,
          );
        }
        let commitGranted = false;
        const authorizeCommit = () => {
          if (!commitGranted) {
            admit("commit");
            commitGranted = true;
          }
        };
        const cliHistoryChanged =
          target.cliWriter && firstSeq !== undefined
            ? advanceCliHistoryBoundaryRangeInTransaction(
                database,
                resolved,
                {
                  first: firstSeq,
                  last:
                    readTranscriptContextVersionInTransaction(database, resolved.sessionId)
                      .rawSeq ?? -1,
                },
                target.cliWriter,
                authorizeCommit,
              )
            : false;
        const rebound = readRefusal();
        if (rebound) {
          throw new SessionTranscriptWriterClaimReboundError(rebound);
        }
        authorizeCommit();
        return ok({
          committed: true,
          projectionNeedsReconcile,
          cliHistoryChanged,
          ...(transcriptChanged
            ? {
                transcriptUpdate: {
                  target: {
                    agentId: resolved.agentId,
                    storePath: resolved.path,
                    sessionKey: resolved.sessionKey,
                    sessionId: resolved.sessionId,
                  },
                  lifecycleRevision,
                },
              }
            : {}),
          ...(abortedPartial
            ? {
                abortedPartial,
                sessionEntryChanged: !abortedPartial.skipped && abortedPartial.append.appended,
              }
            : {}),
        });
      });
    },
    assertSettled() {
      assertOpen();
      if (database.db.isTransaction) {
        throw new Error("Transcript report command left a transaction open");
      }
    },
    close() {
      closed = true;
      prepared = undefined;
    },
  };
}
