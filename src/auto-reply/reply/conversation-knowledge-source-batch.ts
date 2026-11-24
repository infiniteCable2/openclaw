import { isDeepStrictEqual } from "node:util";
import {
  CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import {
  MAX_SESSION_MODEL_CONTEXT_BATCH_RANGES,
  sessionModelContextBatchByteBudget,
} from "../../config/sessions/session-model-context-batch-limits.js";
import { readSessionTranscriptModelContextsAsync } from "../../config/sessions/session-transcript-context-read.js";
import type { createConversationKnowledgeSourceCustody } from "./conversation-knowledge-source-custody.js";

type PreparedSource = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createConversationKnowledgeSourceCustody>>>
>;

function shareReadScope(current: PreparedSource, next: PreparedSource): boolean {
  return (
    isDeepStrictEqual(next.projectionTarget, current.projectionTarget) &&
    next.through.generation === current.through.generation &&
    next.grant.sources[0]?.lifecycleRevision === current.grant.sources[0]?.lifecycleRevision &&
    isDeepStrictEqual(next.grant.sources[0]?.readSource, current.grant.sources[0]?.readSource) &&
    isDeepStrictEqual(current.from, current.grant.contributionRange?.from) &&
    isDeepStrictEqual(next.from, next.grant.contributionRange?.from)
  );
}

/** Each range retains its own grant; only SQLite navigation and scheduling are shared. */
export async function readConversationKnowledgeSourceBatch(params: {
  current: PreparedSource;
  receipt: ConversationKnowledgeReference;
  successors: readonly ConversationKnowledgeReference[];
  prepareNext: (receipt: ConversationKnowledgeReference) => Promise<PreparedSource | undefined>;
  drop: (read: PreparedSource["read"]) => void;
  assertCurrent: () => void;
  signal?: AbortSignal;
}) {
  const { current, receipt, successors, prepareNext, drop, assertCurrent, signal } = params;
  const pending = [{ receipt, source: current }];
  const retained = new Set<PreparedSource>();
  try {
    for (const successor of successors.slice(0, MAX_SESSION_MODEL_CONTEXT_BATCH_RANGES - 1)) {
      if (
        successor.source.sessionId !== receipt.source.sessionId ||
        successor.source.sessionKey !== receipt.source.sessionKey ||
        successor.through.generation !== receipt.through.generation
      ) {
        break;
      }
      let source: PreparedSource | undefined;
      try {
        source = await prepareNext(successor);
      } catch {
        signal?.throwIfAborted();
        assertCurrent();
        break;
      }
      if (!source) {
        break;
      }
      if (!shareReadScope(current, source)) {
        drop(source.read);
        break;
      }
      pending.push({ receipt: successor, source });
    }
    if (pending.length === 1) {
      return undefined;
    }
    // Reuse admitted custody during a bounded retry. A single range falls through to its native reader.
    for (let count = pending.length; count > 1; count = Math.ceil(count / 2)) {
      const selected = pending.slice(0, count);
      const maxBytes = Math.min(
        CONVERSATION_KNOWLEDGE_SOURCE_LIMITS.maxBytes,
        Math.floor(sessionModelContextBatchByteBudget(count) / count),
      );
      assertCurrent();
      try {
        const projections = await readSessionTranscriptModelContextsAsync(
          current.projectionTarget,
          selected.map(({ source: { through, from } }) => ({
            through,
            limits: {
              ...CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
              maxBytes,
              ...(from ? { from } : {}),
            },
          })),
          (contexts) => {
            for (const { source } of selected) {
              source.sourceAssertion();
            }
            return contexts;
          },
          signal,
        );
        const [first, ...following] = projections;
        if (!first?.ok) {
          if (
            first?.reason === "source-range-over-capacity" &&
            maxBytes < CONVERSATION_KNOWLEDGE_SOURCE_LIMITS.maxBytes
          ) {
            continue;
          }
          return undefined;
        }
        const next = selected.slice(1).flatMap((entry, index) => {
          const projection = following[index];
          if (
            !projection ||
            (!projection.ok &&
              projection.reason === "source-range-over-capacity" &&
              maxBytes < CONVERSATION_KNOWLEDGE_SOURCE_LIMITS.maxBytes)
          ) {
            // Its own turn will use the original bound if the smaller share was insufficient.
            return [];
          }
          retained.add(entry.source);
          return [{ ...entry, projection }];
        });
        return { context: first.context, next };
      } catch {
        signal?.throwIfAborted();
        assertCurrent();
      }
    }
    return undefined;
  } finally {
    for (const { source } of pending.slice(1)) {
      if (!retained.has(source)) {
        drop(source.read);
      }
    }
  }
}
