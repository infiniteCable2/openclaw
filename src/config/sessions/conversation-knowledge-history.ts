import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ConversationKnowledgeRootCache,
  type ConversationKnowledgeRootContinuation,
} from "./conversation-knowledge-root-cache.js";
import type { SessionTranscriptRuntimeTarget, TranscriptEvent } from "./session-accessor.types.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionTranscriptWatermark } from "./session-history-read.types.js";
import { withSessionTranscriptDeltaReader } from "./session-transcript-delta-read.js";
import { isSessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
import { readSessionTranscriptWatermarkAsync } from "./session-transcript-watermark.js";

type KnowledgeReportsRead = {
  target: SessionTranscriptRuntimeTarget;
  customTypes: readonly string[];
  modelContextOnly?: boolean;
  detailsOnly?: boolean;
  assertCurrent(): void;
  signal?: AbortSignal;
};

const rootCache = new ConversationKnowledgeRootCache();

/** Only infrastructure roots opt in; recipients retain native compaction-aware reads. */
export async function readConversationKnowledgeRootReports(
  params: Omit<KnowledgeReportsRead, "modelContextOnly" | "detailsOnly"> & {
    source: CapturedSessionEntryReadSource;
    lifecycleRevision: string;
    revalidate(): Promise<void>;
    continuation?: ConversationKnowledgeRootContinuation;
  },
): Promise<TranscriptEvent[]> {
  const target = { ...params.target, storePath: params.source.path };
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    assertCapturedSessionEntryReadSource(params.source);
  };
  assertCurrent();
  return withSessionTranscriptDeltaReader(
    target,
    (reader) =>
      rootCache.read({
        ...params,
        ...target,
        assertCurrent,
        watermark: () => readSessionTranscriptWatermarkAsync(target),
        raw: reader.raw,
        full: (through) =>
          readConversationKnowledgeReportsAt({ ...params, target, assertCurrent }, through),
      }),
    params.signal,
  );
}

/** Page a fixed native prefix, not the model's compacted/bounded context tail. */
export async function readConversationKnowledgeReports(
  params: KnowledgeReportsRead,
): Promise<TranscriptEvent[]> {
  params.signal?.throwIfAborted();
  params.assertCurrent();
  const through = await readSessionTranscriptWatermarkAsync(params.target);
  return readConversationKnowledgeReportsAt(params, through);
}

async function readConversationKnowledgeReportsAt(
  params: KnowledgeReportsRead,
  through: SessionTranscriptWatermark,
): Promise<TranscriptEvent[]> {
  const check = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
  };
  check();
  if (!through.generation || through.maxSeq === null) {
    return [];
  }
  const events: TranscriptEvent[] = [];
  await withSessionTranscriptDeltaReader(
    params.target,
    async (reader) => {
      let cursor: string | undefined;
      let maxBytes = 1_000_000;
      for (;;) {
        check();
        const limits = {
          cursor,
          maxEvents: 96,
          maxBytes,
          customTypes: params.customTypes,
          activePathOnly: true,
          modelContextOnly: params.modelContextOnly,
          customMessageDetailsOnly: params.detailsOnly,
        };
        const page = await reader.raw(limits).catch(async (error: unknown) => {
          if (!isSessionTranscriptProjectionUnavailableError(error)) {
            throw error;
          }
          // The native reader scheduled its projection owner. Join that work once;
          // never create a separate rebuild or spin against a changing transcript.
          check();
          await waitForSessionTranscriptProjection(params.target, params.signal);
          check();
          return reader.raw(limits);
        });
        check();
        if (page.kind !== "page") {
          throw new Error("Conversation knowledge history changed during catch-up");
        }
        if (page.requiredBytes !== undefined) {
          // A large ordinary recipient message must not hide later packet receipts.
          // Native raw reads still enforce their 64-MiB per-page ceiling.
          if (page.requiredBytes <= maxBytes || page.requiredBytes > 64 * 1024 * 1024) {
            throw new Error("Conversation knowledge history contains an oversized unread record");
          }
          maxBytes = page.requiredBytes;
          continue;
        }
        for (const row of page.events) {
          if (row.seq > through.maxSeq!) {
            break;
          }
          const record = asOptionalRecord(row.event);
          if (
            record?.type === "custom_message" &&
            typeof record.customType === "string" &&
            params.customTypes.includes(record.customType)
          ) {
            events.push(row.event);
          }
        }
        if (
          !page.hasMore ||
          (page.events.at(-1)?.seq ?? -1) >= through.maxSeq! ||
          page.events.length === 0
        ) {
          break;
        }
        if (cursor === page.cursor) {
          throw new Error("Conversation knowledge history made no progress");
        }
        cursor = page.cursor;
      }
    },
    params.signal,
  );
  check();
  const current = await readSessionTranscriptWatermarkAsync(params.target);
  check();
  if (current.generation !== through.generation || (current.maxSeq ?? -1) < through.maxSeq) {
    throw new Error("Conversation knowledge history was rewritten during catch-up");
  }
  return events;
}
