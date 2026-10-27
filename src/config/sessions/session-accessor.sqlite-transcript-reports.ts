import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { publishTranscriptUpdate } from "./session-accessor.sqlite-events.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { prepareTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.js";
import {
  appendAbortedSessionTranscriptPartialInTransaction,
  appendSessionTranscriptReportInTransaction,
  prepareTranscriptReportSelection,
  prepareCustomTranscriptReport,
} from "./session-accessor.sqlite-transcript-reports.kernel.js";
import type {
  CustomMessageReport,
  AbortedSessionTranscriptPartial,
  AbortedSessionTranscriptPartialResult,
  TranscriptReport,
  TranscriptReportContextAdmission,
  TranscriptReportBatchEntry,
  TranscriptReportBatchProgress,
  TranscriptReportReceiptQuery,
  TranscriptReportReceiptObservation,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import { MAX_TRANSCRIPT_REPORT_BATCH_SIZE } from "./session-accessor.sqlite-transcript-reports.types.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import type { SessionEntryCurrentCheck } from "./session-entry-current.types.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import { appendCustomTranscriptReportWithWorker } from "./session-transcript-custom-report.js";
import {
  withReportWorker,
  type IncognitoTranscriptReportBinding,
} from "./session-transcript-report-operation.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

export type { IncognitoTranscriptReportBinding } from "./session-transcript-report-operation.js";

async function withNativeCurrentTranscript<T>(
  scope: SessionTranscriptWriteScope,
  run: (database: OpenClawAgentDatabase, resolved: ResolvedTranscriptScope) => T,
): Promise<Result<T, TranscriptAppendRefusal>> {
  const fenced = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fenced);
  return runExclusiveSqliteSessionWrite(
    resolved,
    async () =>
      runOpenClawAgentWriteTransaction(
        (database) => {
          assertOwnedTranscriptWriteCommit(fenced);
          const refusal = resolveTranscriptAppendRefusal(
            readSessionEntryRow(database, resolved.sessionKey, "list")?.entry,
            resolved,
            fenced,
          );
          if (refusal) {
            if (fenced.expectedWriterRunId !== undefined) {
              throw new SessionTranscriptWriterClaimReboundError(refusal);
            }
            return err(refusal);
          }
          const result = run(database, resolved);
          assertOwnedTranscriptWriteCommit(fenced);
          const rebound = resolveTranscriptAppendRefusal(
            readSessionEntryRow(database, resolved.sessionKey, "list")?.entry,
            resolved,
            fenced,
          );
          if (rebound) {
            throw new SessionTranscriptWriterClaimReboundError(rebound);
          }
          return ok(result);
        },
        toDatabaseOptions(resolved),
        { operationLabel: "session.transcript.report" },
      ),
    "session.transcript.report",
  );
}

function isProcessHeldTranscript(scope: SessionTranscriptWriteScope): boolean {
  return (
    isIncognitoSessionKey(scope.sessionKey) ||
    Boolean(
      scope.storePath &&
      isIncognitoOpenClawAgentSqlitePath(scope.storePath, {
        agentId: scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey),
        env: scope.env,
      }),
    )
  );
}

/** Fills a hot transcript only when its settled registered producer left no authoritative answer. */
export async function appendAbortedSessionTranscriptPartial(
  scope: SessionTranscriptWriteScope & { sessionId: string },
  partial: AbortedSessionTranscriptPartial & {
    config?: import("../types.openclaw.js").OpenClawConfig;
  },
  incognito?: IncognitoTranscriptReportBinding,
): Promise<Result<AbortedSessionTranscriptPartialResult, TranscriptAppendRefusal>> {
  const binding = incognito ?? captureIncognitoSessionOperation(scope);
  const publicationScope = {
    ...scope,
    ...(binding
      ? { env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env) }
      : {}),
  };
  const { config, ...input } = partial;
  const preparedMessage = prepareTranscriptMessageAppend({
    message: attachSessionTranscriptRunId(partial.message, partial.runId),
    config,
  });
  if (!preparedMessage || preparedMessage.persistedMessage.role !== "assistant") {
    throw new Error("Aborted partial requires prepared assistant storage bytes");
  }
  const settlement =
    !binding && isProcessHeldTranscript(publicationScope)
      ? await withNativeCurrentTranscript(publicationScope, (database, resolved) =>
          appendAbortedSessionTranscriptPartialInTransaction(
            database,
            resolved,
            input,
            preparedMessage,
          ),
        )
      : await withReportWorker(
          publicationScope,
          "append",
          async (operation, _assertCurrent, publish) => {
            const result = await operation.execute({
              type: "abortedPartial",
              input: { ...input, message: preparedMessage.persistedMessage, preparedMessage },
            });
            if (!result.ok) {
              return result;
            }
            const receipt = result.value.abortedPartial;
            if (!receipt) {
              throw new Error("Aborted partial worker returned no settlement receipt");
            }
            publish(result.value);
            return ok(receipt);
          },
          undefined,
          binding,
        );
  if (settlement.ok && !settlement.value.skipped && settlement.value.append.appended) {
    const { append, lifecycleRevision, messageSeq } = settlement.value;
    await publishTranscriptUpdate(publicationScope, {
      lifecycleRevision,
      messageSeq,
      message: append.message,
      messageId: append.messageId,
      runId: input.runId,
    });
  }
  return settlement;
}

/** Reads the latest matching custom report from the active branch in one snapshot. */
export async function readLatestSessionTranscriptReport(
  scope: SessionTranscriptWriteScope,
  customTypes: readonly string[],
  incognito?: IncognitoTranscriptReportBinding,
): Promise<Result<CustomMessageReport | undefined, TranscriptAppendRefusal>> {
  const binding = incognito ?? captureIncognitoSessionOperation(scope);
  const selectedTypes = [...customTypes];
  if (!binding && isProcessHeldTranscript(scope)) {
    // Process-held incognito databases retain their sole native owner.
    return withNativeCurrentTranscript(
      scope,
      (database, resolved) =>
        prepareTranscriptReportSelection(database, resolved, {
          kind: "custom",
          customTypes: selectedTypes,
        }).latest,
    );
  }
  return withReportWorker(
    scope,
    "read",
    async (operation, assertCurrent) => {
      const prepared = await operation.execute({
        type: "prepare",
        input: { kind: "custom", customTypes: selectedTypes },
      });
      assertCurrent();
      return prepared.ok ? ok(prepared.value.latest) : prepared;
    },
    undefined,
    binding,
  );
}

/** Read bounded producer-owned receipt carriers without changing the current prompt-history fence. */
export async function readSessionTranscriptReportReceipts(
  scope: SessionTranscriptWriteScope,
  reports: readonly TranscriptReportReceiptQuery[],
  options?: { source?: SessionSourceAssertion },
): Promise<Result<TranscriptReportReceiptObservation[], TranscriptAppendRefusal>> {
  if (!reports.length || reports.length > MAX_TRANSCRIPT_REPORT_BATCH_SIZE) {
    throw new Error("Transcript receipt observation exceeds its scheduling quantum");
  }
  if (captureIncognitoSessionOperation(scope) || isProcessHeldTranscript(scope)) {
    throw new Error("Receipt observations require a durable native transcript target");
  }
  const selected = reports.map((query) => {
    if (!query.customType.trim() || !query.receipt.field.trim() || !query.receipt.value.trim()) {
      throw new Error("Transcript receipt observation requires exact nonempty selectors");
    }
    return { customType: query.customType, receipt: { ...query.receipt } };
  });
  return withReportWorker(
    scope,
    "read",
    async (operation, assertCurrent) => {
      assertCurrent();
      const result = await operation.execute({ type: "observe", input: { reports: selected } });
      assertCurrent();
      return result;
    },
    undefined,
    undefined,
    options?.source,
  );
}

/** Selects and appends one report against the same authoritative branch revision. */
export async function appendSessionTranscriptReport(
  scope: SessionTranscriptWriteScope,
  report: TranscriptReport,
  options?: {
    contextAdmission?: TranscriptReportContextAdmission;
    sessionEntryCurrent?: SessionEntryCurrentCheck;
    incognito?: IncognitoTranscriptReportBinding;
    /**
     * Worker-prepared source/recipient predicates in this same physical store.
     * Caller admission still owns source-history and recipient authority.
     */
    source?: SessionSourceAssertion;
  },
): Promise<Result<void, TranscriptAppendRefusal>> {
  const suppliedAdmission = options?.contextAdmission;
  const contextAdmission = suppliedAdmission && {
    limits: structuredClone(suppliedAdmission.limits),
    onDeferred: () => suppliedAdmission.onDeferred(),
  };
  const incognito = options?.incognito ?? captureIncognitoSessionOperation(scope);
  if (
    contextAdmission &&
    (report.kind !== "custom" || incognito || isProcessHeldTranscript(scope))
  ) {
    throw new Error("Context-preserving report admission requires a durable native custom report");
  }
  if (!incognito && isProcessHeldTranscript(scope)) {
    if (options?.source) {
      throw new Error("Composed report sources require a durable native transcript target");
    }
    if (options?.sessionEntryCurrent) {
      throw new Error("A file session source cannot authorize a process-held transcript report");
    }
    return withNativeCurrentTranscript(scope, (database, resolved) =>
      appendSessionTranscriptReportInTransaction(database, resolved, report),
    );
  }
  if (report.kind === "assistant") {
    const preparedMessage = prepareTranscriptMessageAppend({
      message: applyAssistantDeliveryDirectives(report.message),
    });
    if (!preparedMessage) {
      throw new Error("Assistant report requires prepared transcript storage bytes");
    }
    const input = { ...report, message: preparedMessage.persistedMessage, preparedMessage };
    return withReportWorker(
      scope,
      "append",
      async (operation, _assertCurrent, publish) => {
        const result = await operation.execute({ type: "assistant", input });
        if (!result.ok) {
          return result;
        }
        publish(result.value);
        return ok(undefined);
      },
      options?.sessionEntryCurrent,
      incognito,
      options?.source,
    );
  }
  const customReport = {
    ...report,
    customTypes: [...report.customTypes],
    ...(report.receipt ? { receipt: { ...report.receipt } } : {}),
  };
  return withReportWorker(
    scope,
    "append",
    (operation, assertCurrent, publish) =>
      appendCustomTranscriptReportWithWorker({
        operation,
        assertCurrent,
        publish,
        report: customReport,
        contextAdmission,
      }),
    options?.sessionEntryCurrent,
    incognito,
    options?.source,
  );
}

/** Append a bounded exact-receipt prefix under one native report domain and writer admission. */
export async function appendSessionTranscriptReportBatch(
  scope: SessionTranscriptWriteScope,
  reports: readonly TranscriptReportBatchEntry[],
  options?: {
    contextAdmission?: TranscriptReportContextAdmission;
    source?: SessionSourceAssertion;
  },
): Promise<Result<TranscriptReportBatchProgress, TranscriptAppendRefusal>> {
  if (reports.length === 0 || reports.length > MAX_TRANSCRIPT_REPORT_BATCH_SIZE) {
    throw new Error("Transcript report batch exceeds its scheduling quantum");
  }
  if (captureIncognitoSessionOperation(scope) || isProcessHeldTranscript(scope)) {
    throw new Error("Batch reports require a durable native transcript target");
  }
  const entries = reports.map(({ report, receipt }) => ({
    report: { ...report },
    receipt: { ...receipt },
  }));
  const contextAdmission = options?.contextAdmission;
  const limits = contextAdmission && structuredClone(contextAdmission.limits);
  return withReportWorker(
    scope,
    "append",
    async (operation, assertCurrent, publish) => {
      assertCurrent();
      // The original producer owns toJSON and final envelope identity. Serialize
      // only after live writer/source admission, as the single-report owner does.
      const prepared = entries.map(({ report, receipt }) => {
        assertCurrent();
        const selection = { kind: "custom" as const, customTypes: [report.customType], receipt };
        const { eventJson } = prepareCustomTranscriptReport(report, null, selection);
        assertCurrent();
        return { eventJson, customType: report.customType, receipt };
      });
      const result = await operation.execute({
        type: "appendBatch",
        input: { reports: prepared, ...(limits ? { preserveContextLimits: limits } : {}) },
      });
      assertCurrent();
      if (!result.ok) {
        return result;
      }
      if (result.value.committed) {
        publish(result.value);
      }
      if (result.value.deferred) {
        contextAdmission?.onDeferred();
      }
      return ok({
        accepted: result.value.accepted,
        appended: result.value.appended,
        deferred: result.value.deferred === true,
      });
    },
    undefined,
    undefined,
    options?.source,
  );
}
