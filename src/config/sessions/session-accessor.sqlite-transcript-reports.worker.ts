import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
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
import { readSessionTranscriptBoundedActiveContextUsageCore } from "./session-accessor.sqlite-active-context.js";
import { advanceCliHistoryBoundaryRangeInTransaction } from "./session-accessor.sqlite-cli-history-boundary.js";
import type {
  SessionTranscriptWriteScope,
  SessionTranscriptContextVersion,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { resolveTranscriptBoundaryWindow } from "./session-accessor.sqlite-reset-window.js";
import {
  getSessionKysely,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import {
  appendAbortedSessionTranscriptPartialInTransaction,
  appendSelectedTranscriptReportInTransaction,
  prepareTranscriptReportBatchSelection,
  prepareTranscriptReportSelection,
  reparentTranscriptReportBatchEntry,
  transcriptReportBatchReceiptKey,
  readReportBranch,
  readReportEvent,
} from "./session-accessor.sqlite-transcript-reports.kernel.js";
import type {
  AbortedSessionTranscriptPartialResult,
  PreparedTranscriptReport,
  TranscriptReportCommit,
  TranscriptReportBatchCommit,
  TranscriptReportWorkerOperations,
  TranscriptReportReceiptQuery,
  TranscriptReportReceiptObservation,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import { MAX_TRANSCRIPT_REPORT_BATCH_SIZE } from "./session-accessor.sqlite-transcript-reports.types.js";
import {
  readTranscriptContextVersionInTransaction,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import type { TranscriptAppendCursor } from "./session-accessor.sqlite-transcript-store.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { requestSessionEntryCurrentAdmission } from "./session-entry-current-admission.worker.js";
import type { SessionEntryCurrentSource } from "./session-entry-current.types.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import { createSessionSourceValidationScope } from "./session-source-predicate.worker.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";

/** Observe known producer receipts under native report authority, not prompt-history admission. */
export function observeTranscriptReportReceipts(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  reports: readonly TranscriptReportReceiptQuery[],
): TranscriptReportReceiptObservation[] {
  if (!reports.length || reports.length > MAX_TRANSCRIPT_REPORT_BATCH_SIZE) {
    throw new Error("Transcript receipt observation exceeds its scheduling quantum");
  }
  const selected = readCurrentProjectionSnapshot(database, resolved, (projection) => {
    const branch = readReportBranch(database, resolved.sessionId);
    const path = branch.path.toReversed();
    const window = resolveTranscriptBoundaryWindow(projection, "context");
    const observations: TranscriptReportReceiptObservation[] = reports.map((query) => ({
      ...query,
      status: "missing",
    }));
    const wanted = new Map<string, Map<string, Map<string, number[]>>>();
    for (const [index, query] of reports.entries()) {
      let fields = wanted.get(query.customType);
      if (!fields) {
        fields = new Map();
        wanted.set(query.customType, fields);
      }
      let values = fields.get(query.receipt.field);
      if (!values) {
        values = new Map();
        fields.set(query.receipt.field, values);
      }
      const indexes = values.get(query.receipt.value) ?? [];
      indexes.push(index);
      values.set(query.receipt.value, indexes);
    }
    // One reverse path pass selects the latest canonical occurrence for every
    // receipt. Missing queries must not multiply old-body decoding by batch size.
    for (const entry of path) {
      if (wanted.size === 0) {
        break;
      }
      if (entry.type !== "custom_message" || entry.customType === undefined) {
        continue;
      }
      const fields = wanted.get(entry.customType);
      if (!fields) {
        continue;
      }
      const record = readReportEvent(database, resolved.sessionId, entry.seq);
      const details = asOptionalRecord(record?.details);
      const matched: number[] = [];
      for (const [field, values] of fields) {
        const value = details && Object.hasOwn(details, field) ? details[field] : undefined;
        if (typeof value !== "string") {
          continue;
        }
        const indexes = values.get(value);
        if (indexes) {
          matched.push(...indexes);
          values.delete(value);
          if (values.size === 0) {
            fields.delete(field);
          }
        }
      }
      if (matched.length === 0) {
        continue;
      }
      if (!record || record.id !== entry.id || typeof record.content !== "string") {
        throw new Error("Known transcript report carrier has changed its canonical identity");
      }
      const active = executeSqliteQueryTakeFirstSync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_transcript_active_events")
          .select(["active_position", "context_eligible"])
          .where("session_id", "=", resolved.sessionId)
          .where("event_seq", "=", entry.seq),
      );
      if (!active) {
        throw new SessionTranscriptProjectionUnavailableError(resolved.sessionId, "window-changed");
      }
      const inModel =
        (active.context_eligible === 1 &&
          active.active_position >= (window?.boundaryActivePosition ?? 0)) ||
        window?.keptActivePositions.includes(active.active_position) === true;
      const report = {
        customType: entry.customType,
        content: record.content,
        display: record.display === true,
        details: record.details,
      };
      for (const index of matched) {
        observations[index] = {
          ...reports[index]!,
          status: inModel ? "active-model" : "historical",
          eventId: entry.id,
          report,
        };
      }
      if (fields.size === 0) {
        wanted.delete(entry.customType);
      }
    }
    return observations;
  });
  if (selected.kind !== "value") {
    throw new SessionTranscriptProjectionUnavailableError(resolved.sessionId);
  }
  return selected.value;
}

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
  const sourceValidation = createSessionSourceValidationScope(database);
  const admit = (stage: "transaction" | "commit") => {
    const predicates = target.sourcePredicates;
    for (const predicate of predicates ?? []) {
      // Native source predicates are atomic only inside this same physical store.
      assertCapturedSessionEntryReadSource(predicate.source, database);
    }
    const validation = predicates && sourceValidation.read(predicates);
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
  const backend: SqliteWorkerBackend<TranscriptReportWorkerOperations> = {
    execute(command) {
      assertOpen();
      if (command.type === "observe") {
        return runSqliteDeferredTransactionSync<
          Result<TranscriptReportReceiptObservation[], TranscriptAppendRefusal>
        >(database.db, () => {
          if (target.sourcePredicates) {
            admit("transaction");
          }
          const refusal = readRefusal();
          if (refusal) {
            return err(refusal);
          }
          return ok(observeTranscriptReportReceipts(database, resolved, command.input.reports));
        });
      }
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
      if (command.type === "appendBatch") {
        prepared = undefined;
        const { reports, preserveContextLimits: limits } = command.input;
        if (reports.length === 0 || reports.length > MAX_TRANSCRIPT_REPORT_BATCH_SIZE) {
          throw new Error("Transcript report batch exceeds its scheduling quantum");
        }
        let duplicatePrefix = 0;
        try {
          return runOpenClawAgentWriteTransaction(
            (current): Result<TranscriptReportBatchCommit, TranscriptAppendRefusal> => {
              if (current.db !== database.db) {
                throw new Error("Transcript report lost its canonical database owner");
              }
              admit("transaction");
              const refusal = readRefusal();
              if (refusal) {
                admit("commit");
                return err(refusal);
              }
              if (
                command.input.expectedTranscriptVersion &&
                !isDeepStrictEqual(
                  { ...readTranscriptContextVersionInTransaction(database, resolved.sessionId) },
                  command.input.expectedTranscriptVersion,
                )
              ) {
                throw new SessionTranscriptReadFenceError(
                  "Transcript changed before report batch admission",
                );
              }
              const selection = prepareTranscriptReportBatchSelection(database, resolved, reports);
              let appendParentId = selection.appendParentId;
              let projectionNeedsReconcile = false;
              const projection = {
                scheduleProjectionReconcile: false as const,
                touchMutation: false,
                onProjectionReconcileNeeded: () => {
                  projectionNeedsReconcile = true;
                },
              };
              const firstSeq = target.cliWriter
                ? (readTranscriptContextVersionInTransaction(database, resolved.sessionId).rawSeq ??
                    -1) + 1
                : undefined;
              let usage:
                | ReturnType<typeof readSessionTranscriptBoundedActiveContextUsageCore>
                | undefined;
              let accepted = 0;
              let appended = 0;
              let deferred = false;
              // Same transaction and recipient only: reuse the native batch cursor.
              const cursor: TranscriptAppendCursor = {};
              for (const report of reports) {
                const selected = reparentTranscriptReportBatchEntry(report, appendParentId);
                const receiptKey = transcriptReportBatchReceiptKey(report);
                if (selection.existing.has(receiptKey)) {
                  accepted++;
                  continue;
                }
                if (limits) {
                  if (!usage) {
                    ensureTranscriptHeader(database, resolved, undefined, projection);
                    usage = readSessionTranscriptBoundedActiveContextUsageCore(resolved, {
                      ...limits,
                      resolvedScope: resolved,
                    });
                  }
                  const additionalBytes = Buffer.byteLength(selected.eventJson, "utf8") + 1;
                  if (
                    usage.eventCount === 0 ||
                    usage.serializedBytes + additionalBytes > limits.maxBytes ||
                    usage.eventCount + 1 > limits.maxEvents
                  ) {
                    deferred = true;
                    if (appended === 0) {
                      // Roll back a provisional first header, retaining exact duplicate progress.
                      duplicatePrefix = accepted;
                      admit("commit");
                      throw deferredContextAdmission;
                    }
                    break;
                  }
                  usage = {
                    ...usage,
                    serializedBytes: usage.serializedBytes + additionalBytes,
                    eventCount: usage.eventCount + 1,
                  };
                }
                appendSelectedTranscriptReportInTransaction(
                  database,
                  resolved,
                  appendParentId,
                  selected,
                  projection,
                  undefined,
                  cursor,
                );
                appendParentId = selected.eventId;
                selection.existing.add(receiptKey);
                accepted++;
                appended++;
              }
              if (appended > 0) {
                touchTranscriptMutationInTransaction(database, resolved.sessionId);
              }
              let commitGranted = false;
              const authorizeCommit = () => {
                if (!commitGranted) {
                  admit("commit");
                  commitGranted = true;
                }
              };
              const cliHistoryChanged =
                appended > 0 && target.cliWriter && firstSeq !== undefined
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
              if (readRefusal()) {
                throw new SessionTranscriptWriterClaimReboundError();
              }
              authorizeCommit();
              return ok({
                committed: true,
                accepted,
                appended,
                ...(deferred ? { deferred: true as const } : {}),
                projectionNeedsReconcile,
                cliHistoryChanged,
                ...(appended > 0
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
              });
            },
            options,
            { operationLabel: "session.transcript.report" },
          );
        } catch (error) {
          if (error !== deferredContextAdmission) {
            throw error;
          }
          assertOpen();
          if (database.db.isTransaction) {
            throw new Error("Deferred transcript batch left a transaction open", { cause: error });
          }
          // No input was newly appended; existing duplicate receipts are rediscovered on retry.
          return ok({
            committed: false,
            accepted: duplicatePrefix,
            appended: 0,
            deferred: true as const,
            projectionNeedsReconcile: false,
          });
        }
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
            const snapshot = readSessionTranscriptBoundedActiveContextUsageCore(resolved, {
              ...limits,
              resolvedScope: resolved,
            });
            const additionalBytes = Buffer.byteLength(command.input.eventJson, "utf8") + 1;
            // Header and injected boundaries remain counted. The event count is
            // deliberately conservative so no currently hydrated row is displaced.
            if (
              snapshot.eventCount === 0 ||
              snapshot.serializedBytes + additionalBytes > limits.maxBytes ||
              snapshot.eventCount + 1 > limits.maxEvents
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
      sourceValidation.clear();
    },
  };
  return {
    ...backend,
    execute(command) {
      // Only one successful prepare may lend proofs to its immediately following append.
      if (command.type !== "append") {
        sourceValidation.clear();
      }
      try {
        const result = backend.execute(command);
        if (!result.ok || ("suppressed" in result.value && result.value.suppressed)) {
          sourceValidation.clear();
        }
        return result;
      } catch (error) {
        sourceValidation.clear();
        prepared = undefined;
        throw error;
      } finally {
        if (command.type !== "prepare") {
          sourceValidation.clear();
        }
      }
    },
  };
}
