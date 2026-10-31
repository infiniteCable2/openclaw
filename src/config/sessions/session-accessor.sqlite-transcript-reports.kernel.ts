import { randomUUID } from "node:crypto";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import {
  encodeSqliteStringSet,
  iterateSqliteQuerySync,
  sqliteStringSetEntries,
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
} from "./session-accessor.sqlite-transcript-reports.types.js";
import {
  appendTranscriptEventInTransaction,
  type TranscriptAppendCursor,
} from "./session-accessor.sqlite-transcript-store.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  assertCurrentSessionTranscriptHeader,
  findSessionTranscriptHeader,
} from "./session-entry-codec.js";
import { SessionEntryNavigation, type SessionNavigationEntry } from "./session-entry-navigation.js";
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

function readReportBranchSnapshot(
  database: OpenClawAgentDatabase,
  sessionId: string,
  onParsedIdentity?: (seq: number, event: unknown) => void,
) {
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
  const compressedSequences = new Set<number>();
  const branch = new TranscriptReportNavigation(
    (function* () {
      for (const row of rows()) {
        let facts: SessionTranscriptReportFacts;
        if (row.event_json === null) {
          if (onParsedIdentity) {
            compressedSequences.add(row.seq);
          }
          facts = compressedFacts(row.report_json);
        } else {
          const event: unknown = JSON.parse(row.event_json);
          onParsedIdentity?.(row.seq, event);
          facts = projectSessionTranscriptReportFacts(event);
        }
        yield {
          seq: row.seq,
          facts,
        };
      }
    })(),
  ).facts();
  return { branch, compressedSequences };
}

export function readReportBranch(database: OpenClawAgentDatabase, sessionId: string) {
  return readReportBranchSnapshot(database, sessionId).branch;
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

type ReceiptFields = Map<string, Set<string>>;
type ReceiptMatch = { field: string; value: string };

function matchingReportReceipts(details: unknown, fields: ReceiptFields): ReceiptMatch[] {
  const record = asOptionalRecord(details);
  if (!record) {
    return [];
  }
  return [...fields].flatMap(([field, values]) => {
    const value = Object.hasOwn(record, field) ? record[field] : undefined;
    return typeof value === "string" && values.has(value) ? [{ field, value }] : [];
  });
}

/** These selectors round-trip identically through JSON1; exceptional JS strings stay native. */
function supportsNativeReceiptMatch(fields: ReceiptFields): boolean {
  return [...fields].every(
    ([field, values]) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/u.test(field) &&
      [...values].every((value) => /^[\x20-\x7e]+$/u.test(value)),
  );
}

/** Compressed payloads are admitted UTF-8 JSON; retain only receipt details, never old bodies. */
function readCompressedReceiptMatches(
  database: OpenClawAgentDatabase,
  sessionId: string,
  sequences: readonly number[],
  receipts: readonly TranscriptReportReceiptSelection[],
) {
  const requested = sqliteStringSetEntries(encodeSqliteStringSet(sequences.map(String))).as(
    "requested",
  );
  const db = getSessionKysely(database.db);
  // The compressed owner rejects escaped Unicode/NUL and non-roundtripping UTF-8.
  // Last property occurrences preserve JSON.parse/Object.hasOwn semantics even
  // for retained envelopes containing duplicate root or receipt keys.
  const query = db
    .with(
      (cte) => cte("receipt_details").materialized(),
      (builder) =>
        builder
          .selectFrom("transcript_events")
          .select([
            "seq",
            /* kysely-allow-raw: bound canonical candidates project the last direct details value once per compressed frame. */
            sql<string | null>`(SELECT json_object('type', member.type, 'value', member.value)
              FROM json_each(${transcriptEventJsonSql(database.db)}) AS member
              WHERE member.key = 'details' ORDER BY member.id DESC LIMIT 1)`.as("envelope"),
          ])
          .where("session_id", "=", sessionId)
          .where("seq", "in", (eb) =>
            eb
              .selectFrom(requested)
              .select((item) => item.cast<number>("requested.value", "integer").as("seq")),
          ),
    )
    .selectFrom("receipt_details as candidate")
    .innerJoin(
      /* kysely-allow-raw: scalar/array details never satisfy the native direct-object receipt contract. */
      sql<{ key: string; value: string; type: string; id: number }>`json_each(
        CASE WHEN json_extract(candidate.envelope, '$.type') = 'object'
          THEN json_extract(candidate.envelope, '$.value') ELSE '{}' END)`.as("detail"),
      (join) => join.onTrue(),
    )
    .select(["candidate.seq", "detail.key as field", "detail.value"])
    .where("detail.type", "=", "text")
    .where(
      /* kysely-allow-raw: receipt selectors are bound data and match strictly typed direct keys, never JSON paths. */
      sql<boolean>`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(receipts)}) AS wanted
        WHERE json_extract(wanted.value, '$.field') = detail.key
          AND json_extract(wanted.value, '$.value') = detail.value)`,
    )
    .where(
      /* kysely-allow-raw: JSON.parse keeps the final duplicate property, including a non-string replacement. */
      sql<boolean>`NOT EXISTS (SELECT 1 FROM json_each(
        json_extract(candidate.envelope, '$.value')) AS later
        WHERE later.key = detail.key AND later.id > detail.id)`,
    );
  return iterateSqliteQuerySync(database.db, query);
}

/** One native branch snapshot selects a whole bounded batch without rereading old bodies per ID. */
export function prepareTranscriptReportBatchSelection(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  reports: readonly PreparedTranscriptReportBatchEntry[],
) {
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
  const identityMatches = new Map<number, ReceiptMatch[]>();
  const { branch, compressedSequences } = readReportBranchSnapshot(
    database,
    resolved.sessionId,
    (seq, event) => {
      const record = asOptionalRecord(event);
      const fields = typeof record?.customType === "string" && wanted.get(record.customType);
      if (fields) {
        const matches = matchingReportReceipts(record.details, fields);
        if (matches.length) {
          identityMatches.set(seq, matches);
        }
      }
    },
  );
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
  const compressed: number[] = [];
  const exceptional: number[] = [];
  const accept = (seq: number, receipt: ReceiptMatch) => {
    const { customType, fields } = selected.get(seq)!;
    if (fields.get(receipt.field)?.has(receipt.value)) {
      existing.add(transcriptReportBatchReceiptKey({ customType, receipt }));
    }
  };
  for (const [seq, { fields }] of selected) {
    if (!compressedSequences.has(seq)) {
      for (const receipt of identityMatches.get(seq) ?? []) {
        accept(seq, receipt);
      }
    } else if (supportsNativeReceiptMatch(fields)) {
      compressed.push(seq);
    } else {
      exceptional.push(seq);
    }
  }
  if (compressed.length) {
    for (const match of readCompressedReceiptMatches(
      database,
      resolved.sessionId,
      compressed,
      reports
        .map((report) => report.receipt)
        .filter(
          ({ field, value }) =>
            /^[A-Za-z_][A-Za-z0-9_]*$/u.test(field) && /^[\x20-\x7e]+$/u.test(value),
        ),
    )) {
      accept(match.seq, match);
    }
  }
  // Exceptional receipt selectors retain exact JavaScript string/property semantics.
  if (exceptional.length) {
    for (const row of readReportEvent(database, resolved.sessionId, exceptional)) {
      const { fields } = selected.get(row.seq)!;
      for (const receipt of matchingReportReceipts(row.event?.details, fields)) {
        accept(row.seq, receipt);
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
