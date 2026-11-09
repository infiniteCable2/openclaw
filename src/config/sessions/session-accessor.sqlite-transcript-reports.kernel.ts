import { randomUUID } from "node:crypto";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeUsage } from "../../agents/usage.js";
import {
  encodeSqliteStringSet,
  iterateSqliteQuerySync,
  sqliteStringSetEntries,
} from "../../infra/kysely-sync.js";
import type { AssistantMessage } from "../../llm/types.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { TranscriptAppendCursor } from "./session-accessor.sqlite-transcript-append.types.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.types.js";
import type {
  AbortedSessionTranscriptPartial,
  AbortedSessionTranscriptPartialResult,
  CustomMessageReportAppend,
  CustomMessageReport,
  PreparedTranscriptReport,
  SelectedTranscriptReport,
  TranscriptReportSelection,
  TranscriptReportReceiptSelection,
  PreparedTranscriptReportBatchEntry,
  TranscriptReport,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { projectSessionUsageSnapshot } from "./session-entry-usage.js";
import { hasSettledTranscriptAssistant } from "./session-transcript-report-policy.js";
import {
  readTranscriptReportNavigation,
  readTranscriptReportEvent,
} from "./session-transcript-report-read.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

export function readReportBranch(database: OpenClawAgentDatabase, sessionId: string) {
  return readTranscriptReportNavigation(database, sessionId).facts();
}
type ReportEventRow = { seq: number; event: ReturnType<typeof asOptionalRecord> };
export function readReportEvent(
  database: OpenClawAgentDatabase,
  sessionId: string,
  seq: number,
): ReportEventRow["event"];
export function readReportEvent(
  database: OpenClawAgentDatabase,
  sessionId: string,
  seqs: readonly number[],
): IterableIterator<ReportEventRow>;
export function readReportEvent(
  database: OpenClawAgentDatabase,
  sessionId: string,
  selection: number | readonly number[],
): ReportEventRow["event"] | IterableIterator<ReportEventRow> {
  const selected = typeof selection === "number" ? [selection] : selection;
  if (selected.some((seq) => !Number.isSafeInteger(seq))) {
    throw new Error("Transcript report selection requires exact integer sequences");
  }
  const sequences = sqliteStringSetEntries(encodeSqliteStringSet(selected.map(String))).as(
    "requested",
  );
  const rows = (function* () {
    for (const row of iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(["seq", transcriptEventJsonSql(database.db).as("event_json")])
        .where("session_id", "=", sessionId)
        .where("seq", "in", (eb) =>
          eb
            .selectFrom(sequences)
            .select((requested) => requested.cast<number>("requested.value", "integer").as("seq")),
        ),
    )) {
      yield { seq: row.seq, event: asOptionalRecord(JSON.parse(row.event_json)) };
    }
  })();
  if (typeof selection !== "number") {
    return rows;
  }
  for (const row of rows) {
    return row.event;
  }
  return undefined;
}

function latestCustomReport(
  database: OpenClawAgentDatabase,
  sessionId: string,
  branch: ReturnType<typeof readReportBranch>,
  customTypes: readonly string[],
  receipt?: TranscriptReportReceiptSelection,
): CustomMessageReport | undefined {
  for (const entry of branch.path.toReversed()) {
    if (
      entry.type !== "custom_message" ||
      entry.customType === undefined ||
      !customTypes.includes(entry.customType)
    ) {
      continue;
    }
    const record = readReportEvent(database, sessionId, entry.seq);
    if (record && (!receipt || matchesReportReceipt(record.details, receipt))) {
      return { customType: entry.customType, content: record.content, details: record.details };
    }
  }
  return undefined;
}

/** Receipt fields are quoted producer data, never authority or conversation enrollment. */
function matchesReportReceipt(
  details: unknown,
  receipt: TranscriptReportReceiptSelection,
): boolean {
  const record = asOptionalRecord(details);
  return Boolean(
    record && Object.hasOwn(record, receipt.field) && record[receipt.field] === receipt.value,
  );
}

export function transcriptReportBatchReceiptKey(
  entry: Pick<PreparedTranscriptReportBatchEntry, "customType" | "receipt">,
): string {
  return JSON.stringify([entry.customType, entry.receipt.field, entry.receipt.value]);
}

/** One native branch snapshot selects a whole bounded batch without rereading old bodies per ID. */
export function prepareTranscriptReportBatchSelection(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  reports: readonly PreparedTranscriptReportBatchEntry[],
) {
  const branch = readReportBranch(database, resolved.sessionId);
  const wanted = new Map<string, Map<string, Set<string>>>();
  for (const report of reports) {
    let fields = wanted.get(report.customType);
    if (!fields) {
      fields = new Map();
      wanted.set(report.customType, fields);
    }
    let values = fields.get(report.receipt.field);
    if (!values) {
      values = new Set();
      fields.set(report.receipt.field, values);
    }
    values.add(report.receipt.value);
  }
  const existing = new Set<string>();
  const selected = new Map(
    branch.path.flatMap((entry) => {
      if (entry.type !== "custom_message" || entry.customType === undefined) {
        return [];
      }
      const fields = wanted.get(entry.customType);
      return fields ? [[entry.seq, { customType: entry.customType, fields }] as const] : [];
    }),
  );
  if (!selected.size) {
    return { appendParentId: branch.appendParentId, existing };
  }
  // Stream only canonical matching bodies through one native query. Repeated
  // missing receipts must not issue one payload SELECT per old ledger entry.
  for (const row of readReportEvent(database, resolved.sessionId, [...selected.keys()])) {
    const { customType, fields } = selected.get(row.seq)!;
    const details = asOptionalRecord(row.event?.details);
    for (const [field, values] of fields) {
      const value = details && Object.hasOwn(details, field) ? details[field] : undefined;
      if (typeof value === "string" && values.has(value)) {
        existing.add(
          transcriptReportBatchReceiptKey({
            customType,
            receipt: { field, value },
          }),
        );
      }
    }
  }
  return { appendParentId: branch.appendParentId, existing };
}

/** Host serialization owns identity and toJSON; only the canonical append parent is worker-owned. */
export function reparentTranscriptReportBatchEntry(
  report: PreparedTranscriptReportBatchEntry,
  appendParentId: string | null,
): Extract<SelectedTranscriptReport, { kind: "custom" }> & { eventId: string } {
  const event = asOptionalRecord(JSON.parse(report.eventJson));
  if (
    !event ||
    event.type !== "custom_message" ||
    typeof event.id !== "string" ||
    event.customType !== report.customType ||
    event.appendMode === "side" ||
    !matchesReportReceipt(event.details, report.receipt)
  ) {
    throw new Error("Transcript batch report does not match its exact receipt.");
  }
  event.parentId = appendParentId;
  return { kind: "custom", eventJson: JSON.stringify(event), eventId: event.id };
}

export function prepareTranscriptReportSelection(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  selection: TranscriptReportSelection,
): PreparedTranscriptReport {
  const branch = readReportBranch(database, resolved.sessionId);
  const suppressed =
    selection.kind === "assistant"
      ? branch.path.some((entry) => entry.assistantResponseId === selection.responseId)
      : selection.suppressWhenAssistantRun !== undefined &&
        branch.path.some((entry) => {
          if (entry.assistantRunId !== selection.suppressWhenAssistantRun) {
            return false;
          }
          // Progress and commentary cannot stand in for a durable failure outcome.
          const message = readReportEvent(database, resolved.sessionId, entry.seq)?.message;
          return isRecord(message) && message.stopReason === "error";
        });
  return {
    appendParentId: branch.appendParentId,
    suppressed,
    latest:
      selection.kind === "custom" && !suppressed
        ? latestCustomReport(
            database,
            resolved.sessionId,
            branch,
            selection.customTypes,
            selection.receipt,
          )
        : undefined,
  };
}

/** Process-held reports select and append without crossing their native transaction boundary. */
export function appendSessionTranscriptReportInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  report: TranscriptReport,
): void {
  const facts = prepareTranscriptReportSelection(
    database,
    resolved,
    report.kind === "assistant"
      ? { kind: "assistant", responseId: report.message.responseId }
      : report,
  );
  if (facts.suppressed) {
    return;
  }
  if (report.kind === "assistant") {
    appendSelectedTranscriptReportInTransaction(database, resolved, facts.appendParentId, report);
    return;
  }
  const selected = report.selectReport(facts.latest);
  if (selected) {
    appendSelectedTranscriptReportInTransaction(
      database,
      resolved,
      facts.appendParentId,
      prepareCustomTranscriptReport(selected, facts.appendParentId, report),
    );
  }
}

/** The producer has settled; only its committed answer may replace the buffered fallback. */
export function appendAbortedSessionTranscriptPartialInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  partial: AbortedSessionTranscriptPartial,
  preparedMessage: PreparedTranscriptMessageAppend<Record<string, unknown>>,
  projection?: { scheduleProjectionReconcile: false; onProjectionReconcileNeeded: () => void },
  onEntryUpdated?: (entry: InternalSessionEntry) => void,
): AbortedSessionTranscriptPartialResult {
  assertSessionTranscriptHot(database.db, resolved.sessionId);
  const entry = readSessionEntryRow(database, resolved.sessionKey)?.entry;
  if (
    !entry ||
    entry.sessionId !== resolved.sessionId ||
    (partial.expectedLifecycleRevision !== undefined &&
      entry.lifecycleRevision !== (partial.expectedLifecycleRevision ?? undefined))
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const branch = readTranscriptReportNavigation(database, resolved.sessionId).facts();
  if (
    hasSettledTranscriptAssistant(
      branch,
      (seq) => readTranscriptReportEvent(database, resolved.sessionId, seq),
      partial.runId,
    )
  ) {
    return { skipped: true };
  }
  // Deferred Gateway settlement has no model writer context; recheck durable custody here.
  if (entry.activeWriterRunId !== undefined && entry.activeWriterRunId !== partial.runId) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const committed = appendTranscriptMessageInTransaction(
    database,
    resolved,
    {
      message: preparedMessage.persistedMessage,
      parentId: branch.appendParentId,
      idempotencyLookup: "scan-assistant",
      now: partial.now,
      useRawWhenLinear: true,
    },
    preparedMessage,
    projection,
  );
  const append = committed?.result;
  if (!append) {
    throw new Error("Aborted assistant partial was not appended");
  }
  if (append.appended) {
    // Appending can update transcript-owned entry fields; retain the authoritative row.
    const current = readSessionEntryRow(database, resolved.sessionKey)?.entry;
    if (!current || current.sessionId !== resolved.sessionId) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    const updatedEntry = writeSessionEntry(
      database,
      resolved.sessionKey,
      {
        ...current,
        // The fallback and its unavailable usage are one committed observation.
        ...projectSessionUsageSnapshot(
          normalizeUsage(asOptionalRecord(preparedMessage.persistedMessage.usage)),
          undefined,
        ),
        updatedAt: Math.max(current.updatedAt ?? 0, Date.now()),
      },
      { canonicalPreviousEntry: current },
    );
    onEntryUpdated?.(updatedEntry);
  }
  return {
    skipped: false,
    append,
    lifecycleRevision: entry.lifecycleRevision,
    ...(append.anchor ? { messageSeq: append.anchor.activeMessagePosition + 1 } : {}),
  };
}

/** Serialize the final envelope here so user-owned toJSON methods run once before transfer. */
export function prepareCustomTranscriptReport(
  selected: CustomMessageReportAppend,
  appendParentId: string | null,
  selection?: Extract<TranscriptReportSelection, { kind: "custom" }>,
): Extract<SelectedTranscriptReport, { kind: "custom" }> {
  const eventId = randomUUID();
  const eventJson = JSON.stringify({
    type: "custom_message",
    ...selected,
    id: eventId,
    parentId: appendParentId,
    timestamp: new Date().toISOString(),
  });
  if (eventJson === undefined) {
    throw new Error("Session transcript report serialization did not produce an event");
  }
  // Compare the actual bytes, including producer-owned toJSON conversions.
  if (selection?.receipt) {
    const record = asOptionalRecord(JSON.parse(eventJson));
    if (
      !record ||
      record.type !== "custom_message" ||
      record.id !== eventId ||
      record.parentId !== appendParentId ||
      typeof record.customType !== "string" ||
      !selection.customTypes.includes(record.customType) ||
      !matchesReportReceipt(record.details, selection.receipt)
    ) {
      throw new Error("Transcript report does not match its selected receipt.");
    }
  }
  return { kind: "custom", eventJson };
}

export function appendSelectedTranscriptReportInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  appendParentId: string | null,
  report: SelectedTranscriptReport,
  projection?: {
    scheduleProjectionReconcile: false;
    onProjectionReconcileNeeded: () => void;
    touchMutation?: boolean;
  },
  preparedMessage?: PreparedTranscriptMessageAppend<AssistantMessage & { responseId: string }>,
  cursor?: TranscriptAppendCursor,
): boolean {
  if (report.kind === "assistant") {
    const committed = appendTranscriptMessageInTransaction(
      database,
      resolved,
      {
        message:
          preparedMessage?.persistedMessage ?? applyAssistantDeliveryDirectives(report.message),
        parentId: appendParentId,
      },
      preparedMessage,
      projection,
    );
    return committed?.result.appended === true;
  }
  if (!cursor?.initialized) {
    ensureTranscriptHeader(database, resolved, undefined, projection);
  }
  const event: unknown = JSON.parse(report.eventJson);
  const appended = appendTranscriptEventInTransaction(
    database,
    resolved,
    event,
    { ...projection, eventJson: report.eventJson },
    cursor,
  );
  if (!appended) {
    throw new Error("Session transcript report was not appended");
  }
  return true;
}
