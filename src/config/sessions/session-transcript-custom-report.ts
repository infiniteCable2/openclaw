import { ok, type Result } from "@openclaw/normalization-core/result";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import type { TranscriptAppendRefusal } from "./session-accessor.sqlite-contract.js";
import { prepareCustomTranscriptReport } from "./session-accessor.sqlite-transcript-reports.kernel.js";
import type {
  TranscriptReport,
  TranscriptReportCommit,
  TranscriptReportContextAdmission,
  TranscriptReportWorkerOperations,
} from "./session-accessor.sqlite-transcript-reports.types.js";

/** Select, serialize, and admit a custom report before its native writer commits it. */
export async function appendCustomTranscriptReportWithWorker(params: {
  operation: Pick<SqliteWorkerStore<TranscriptReportWorkerOperations>, "execute">;
  report: Extract<TranscriptReport, { kind: "custom" }>;
  assertCurrent(): void;
  publish(result: TranscriptReportCommit): void;
  contextAdmission?: TranscriptReportContextAdmission;
}): Promise<Result<void, TranscriptAppendRefusal>> {
  const { report, operation, assertCurrent } = params;
  const selection = {
    kind: report.kind,
    customTypes: [...report.customTypes],
    ...(report.receipt ? { receipt: { ...report.receipt } } : {}),
    suppressWhenAssistantRun: report.suppressWhenAssistantRun,
  };
  const limits = params.contextAdmission && structuredClone(params.contextAdmission.limits);
  for (let attempt = 0; attempt < 3; attempt++) {
    const prepared = await operation.execute({ type: "prepare", input: selection });
    assertCurrent();
    if (!prepared.ok) {
      return prepared;
    }
    if (prepared.value.suppressed) {
      return ok(undefined);
    }
    const selected = report.selectReport(prepared.value.latest);
    assertCurrent();
    if (!selected) {
      return ok(undefined);
    }
    const input = prepareCustomTranscriptReport(selected, prepared.value.appendParentId, selection);
    assertCurrent();
    const result = await operation.execute({
      type: "append",
      input: { ...input, ...(limits ? { preserveContextLimits: limits } : {}) },
    });
    if (!result.ok) {
      return result;
    }
    if (result.value.deferred) {
      assertCurrent();
      params.contextAdmission?.onDeferred();
      return ok(undefined);
    }
    if (result.value.committed) {
      params.publish(result.value);
      return ok(undefined);
    }
    // Only a proven no-write revision mismatch permits another selection.
  }
  throw new Error("Session transcript kept changing while selecting its report");
}
