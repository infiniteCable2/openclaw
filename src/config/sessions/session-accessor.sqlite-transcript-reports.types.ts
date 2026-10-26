import type { Result } from "@openclaw/normalization-core/result";
import type { AssistantMessage } from "../../llm/types.js";
import type { InternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type {
  TranscriptAppendRefusal,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.types.js";
import type { SessionModelContextLimits } from "./session-history-read.types.js";

export type TranscriptReportContextAdmission = {
  limits: Pick<SessionModelContextLimits, "maxBytes" | "maxEvents">;
  onDeferred(): void;
};

export type AbortedSessionTranscriptPartial = {
  runId: string;
  message: Record<string, unknown>;
  now?: number;
  expectedLifecycleRevision?: string | null;
};

export type AbortedSessionTranscriptPartialResult =
  | { skipped: true }
  | {
      skipped: false;
      append: TranscriptMessageAppendResult<Record<string, unknown>>;
      lifecycleRevision?: string;
      messageSeq?: number;
    };

export type CustomMessageReport = { customType: string; content: unknown; details?: unknown };
export type CustomMessageReportAppend = {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
};
/** Exact producer-owned receipt metadata; this selector grants no source access. */
export type TranscriptReportReceiptSelection = {
  field: string;
  value: string;
};
export type TranscriptReport =
  | { kind: "assistant"; message: AssistantMessage & { responseId: string } }
  | {
      kind: "custom";
      customTypes: readonly string[];
      /** Select a source's receipt from existing details without changing stored envelopes. */
      receipt?: TranscriptReportReceiptSelection;
      suppressWhenAssistantRun?: string;
      /**
       * Pure selection; a definite concurrent transcript change may repeat it.
       * Selection sees receipts on the current transcript path, not global history.
       * Producers compare their monotonic accepted endpoint here and skip
       * older/equal ranges; naming a receipt alone does not deduplicate history.
       */
      selectReport: (
        latest: CustomMessageReport | undefined,
      ) => CustomMessageReportAppend | undefined;
    };

export type SelectedTranscriptReport =
  | Extract<TranscriptReport, { kind: "assistant" }>
  | {
      kind: "custom";
      eventJson: string;
      /** Ephemeral append admission, never part of the persisted event envelope. */
      preserveContextLimits?: TranscriptReportContextAdmission["limits"];
    };

export type TranscriptReportSelection =
  | { kind: "assistant"; responseId: string }
  | Pick<
      Extract<TranscriptReport, { kind: "custom" }>,
      "kind" | "customTypes" | "receipt" | "suppressWhenAssistantRun"
    >;

export type PreparedTranscriptReport = {
  appendParentId: string | null;
  suppressed: boolean;
  latest: CustomMessageReport | undefined;
};

export type TranscriptReportCommit = {
  committed: boolean;
  projectionNeedsReconcile: boolean;
  deferred?: true;
  cliHistoryChanged?: boolean;
  abortedPartial?: AbortedSessionTranscriptPartialResult;
  sessionEntryChanged?: boolean;
  /** Exact committed target; metadata-only wakeups never re-resolve a caller's selector. */
  transcriptUpdate?: {
    target: NonNullable<InternalSessionTranscriptUpdate["target"]>;
    lifecycleRevision?: string;
  };
};

export type TranscriptReportWorkerOperations = {
  abortedPartial: {
    input: AbortedSessionTranscriptPartial & {
      preparedMessage: PreparedTranscriptMessageAppend<Record<string, unknown>>;
    };
    output: Result<TranscriptReportCommit, TranscriptAppendRefusal>;
  };
  prepare: {
    input: TranscriptReportSelection;
    output: Result<PreparedTranscriptReport, TranscriptAppendRefusal>;
  };
  append: {
    input: Extract<SelectedTranscriptReport, { kind: "custom" }>;
    output: Result<TranscriptReportCommit, TranscriptAppendRefusal>;
  };
  assistant: {
    input: Extract<TranscriptReport, { kind: "assistant" }> & {
      preparedMessage: PreparedTranscriptMessageAppend<
        Extract<TranscriptReport, { kind: "assistant" }>["message"]
      >;
    };
    output: Result<TranscriptReportCommit, TranscriptAppendRefusal>;
  };
};
