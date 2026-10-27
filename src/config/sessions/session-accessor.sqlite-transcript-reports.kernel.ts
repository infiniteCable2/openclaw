import { randomUUID } from "node:crypto";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { AssistantMessage } from "../../llm/types.js";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { projectAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import {
  isOpenClawMessageToolMirrorAssistantMessage,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../../shared/transcript-only-openclaw-assistant.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { resolveTranscriptBoundaryWindow } from "./session-accessor.sqlite-reset-window.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.types.js";
import type {
  AbortedSessionTranscriptPartial,
  AbortedSessionTranscriptPartialResult,
  CustomMessageReport,
  CustomMessageReportAppend,
  PreparedTranscriptReport,
  SelectedTranscriptReport,
  TranscriptReportSelection,
  TranscriptReportReceiptSelection,
  PreparedTranscriptReportBatchEntry,
  TranscriptReport,
  TranscriptReportReceiptQuery,
  TranscriptReportReceiptObservation,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import { MAX_TRANSCRIPT_REPORT_BATCH_SIZE } from "./session-accessor.sqlite-transcript-reports.types.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  assertCurrentSessionTranscriptHeader,
  findSessionTranscriptHeader,
} from "./session-entry-codec.js";
import { SessionEntryNavigation, type SessionNavigationEntry } from "./session-entry-navigation.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  decodeSessionTranscriptReportFacts,
  projectSessionTranscriptReportFacts,
  type SessionTranscriptReportFacts,
} from "./session-transcript-report-facts.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";

type ReportNavigationEntry = SessionNavigationEntry & {
  seq: number;
  customType?: string;
  assistantResponseId?: string;
  assistantRunId?: string;
};

class TranscriptReportNavigation extends SessionEntryNavigation<ReportNavigationEntry> {
  constructor(rows: Iterable<{ seq: number; facts: SessionTranscriptReportFacts }>) {
    super();
    for (const { seq, facts } of rows) {
      switch (facts.kind) {
        case "canonical":
          this.appendCanonicalNavigationEntry(
            { ...facts.entry, parentId: facts.entry.parentId ?? null, seq },
            facts.hasParentId,
          );
          break;
        case "leaf":
          this.appendOpaqueNavigationRecord({ ...facts.entry, type: "leaf" });
          break;
        case "link":
          this.appendOpaqueNavigationRecord(facts);
          break;
        case "ignored":
          break;
      }
    }
    this.finishNavigation();
  }

  facts() {
    return { appendParentId: this.appendParentId, path: this.getBranch() };
  }
}

function readReportBranch(database: OpenClawAgentDatabase, sessionId: string) {
  function rows() {
    return iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select((eb) => [
          "seq",
          "event_json",
          eb
            .fn<string | null>("json_extract", [eb.ref("navigation_json"), eb.val("$.report")])
            .as("report_json"),
        ])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    );
  }
  function compressedFacts(reportJson: string | null): SessionTranscriptReportFacts {
    const facts =
      reportJson === null ? undefined : decodeSessionTranscriptReportFacts(JSON.parse(reportJson));
    if (!facts) {
      throw new Error("Invalid compressed transcript report facts");
    }
    return facts;
  }
  let hasRows = false;
  const header = findSessionTranscriptHeader(
    (function* () {
      for (const row of rows()) {
        hasRows = true;
        if (row.event_json !== null) {
          yield JSON.parse(row.event_json) as unknown;
        } else {
          compressedFacts(row.report_json);
        }
      }
    })(),
  );
  if (hasRows) {
    assertCurrentSessionTranscriptHeader(header);
  }
  return new TranscriptReportNavigation(
    (function* () {
      for (const row of rows()) {
        yield {
          seq: row.seq,
          facts:
            row.event_json === null
              ? compressedFacts(row.report_json)
              : projectSessionTranscriptReportFacts(JSON.parse(row.event_json)),
        };
      }
    })(),
  ).facts();
}

function readReportEvent(database: OpenClawAgentDatabase, sessionId: string, seq: number) {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select(transcriptEventJsonSql(database.db).as("event_json"))
      .where("session_id", "=", sessionId)
      .where("seq", "=", seq),
  );
  const event: unknown = row ? JSON.parse(row.event_json) : undefined;
  return asOptionalRecord(event);
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
  for (const entry of branch.path) {
    if (entry.type !== "custom_message" || entry.customType === undefined) {
      continue;
    }
    const fields = wanted.get(entry.customType);
    if (!fields) {
      continue;
    }
    const details = asOptionalRecord(
      readReportEvent(database, resolved.sessionId, entry.seq)?.details,
    );
    for (const [field, values] of fields) {
      const value = details && Object.hasOwn(details, field) ? details[field] : undefined;
      if (typeof value === "string" && values.has(value)) {
        existing.add(
          transcriptReportBatchReceiptKey({
            customType: entry.customType,
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
  const branch = readReportBranch(database, resolved.sessionId);
  for (const candidate of branch.path.toReversed()) {
    if (candidate.assistantRunId !== partial.runId) {
      continue;
    }
    const message = readReportEvent(database, resolved.sessionId, candidate.seq)?.message;
    if (
      !isRecord(message) ||
      readSessionTranscriptRunId(message) !== partial.runId ||
      resolveTerminalAssistantTranscriptRunId(message, partial.runId) === undefined ||
      isOpenClawMessageToolMirrorAssistantMessage(message) ||
      isTranscriptOnlyOpenClawAssistantMessage(message)
    ) {
      continue;
    }
    const metadata = asOptionalRecord(message["__openclaw"]);
    if (metadata?.mirrorOrigin !== undefined && metadata.runTerminal !== true) {
      continue;
    }
    // Commentary, media-only receipts, and empty error rows do not own buffered answer text.
    if (extractAssistantPhaseText(projectAssistantDisplayContent(message))?.trim()) {
      return { skipped: true };
    }
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
    writeSessionEntry(
      database,
      resolved.sessionKey,
      { ...current, updatedAt: Math.max(current.updatedAt ?? 0, Date.now()) },
      { canonicalPreviousEntry: current },
    );
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
  projection?: { scheduleProjectionReconcile: false; onProjectionReconcileNeeded: () => void },
  preparedMessage?: PreparedTranscriptMessageAppend<AssistantMessage & { responseId: string }>,
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
  ensureTranscriptHeader(database, resolved, undefined, projection);
  const event: unknown = JSON.parse(report.eventJson);
  const appended = appendTranscriptEventInTransaction(database, resolved, event, {
    ...projection,
    eventJson: report.eventJson,
  });
  if (!appended) {
    throw new Error("Session transcript report was not appended");
  }
  return true;
}
