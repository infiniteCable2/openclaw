import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { resolveTranscriptBoundaryWindow } from "./session-accessor.sqlite-reset-window.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  readReportBranch,
  readBoundedReportEvents,
} from "./session-accessor.sqlite-transcript-reports.kernel.js";
import {
  MAX_TRANSCRIPT_REPORT_BATCH_SIZE,
  type TranscriptReportReceiptQuery,
  type TranscriptReportReceiptObservation,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";

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
    // Try the latest carrier by itself first. Follow it with bounded native
    // batches in canonical path order, even if imported rows have another order.
    for (
      let start = 0, batchSize = 1;
      start < path.length && wanted.size > 0;
      batchSize = Math.min(MAX_TRANSCRIPT_REPORT_BATCH_SIZE, batchSize * 8)
    ) {
      const bySeq = new Map<number, { entry: (typeof path)[number]; customType: string }>();
      while (start < path.length && bySeq.size < batchSize) {
        const entry = path[start++]!;
        const { customType } = entry;
        if (entry.type === "custom_message" && customType !== undefined && wanted.has(customType)) {
          bySeq.set(entry.seq, { entry, customType });
        }
      }
      for (const { seq, event: record } of readBoundedReportEvents(database, resolved.sessionId, [
        ...bySeq.keys(),
      ])) {
        const { entry, customType } = bySeq.get(seq)!;
        const fields = wanted.get(customType);
        if (!fields) {
          continue;
        }
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
          throw new SessionTranscriptProjectionUnavailableError(
            resolved.sessionId,
            "window-changed",
          );
        }
        const inModel =
          (active.context_eligible === 1 &&
            active.active_position >= (window?.boundaryActivePosition ?? 0)) ||
          window?.keptActivePositions.includes(active.active_position) === true;
        const report = {
          customType,
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
          wanted.delete(customType);
        }
        if (wanted.size === 0) {
          break;
        }
      }
    }
    return observations;
  });
  if (selected.kind !== "value") {
    throw new SessionTranscriptProjectionUnavailableError(resolved.sessionId);
  }
  return selected.value;
}
