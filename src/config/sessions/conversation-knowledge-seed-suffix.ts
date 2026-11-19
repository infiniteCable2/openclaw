import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { CONVERSATION_KNOWLEDGE_SEED } from "./conversation-knowledge-context-kinds.js";
import type { SessionTranscriptRawDeltaResult } from "./session-accessor.types.js";
import { createTranscriptRawDeltaCursor } from "./session-transcript-raw-cursor.js";

const MAX_SEED_SUFFIX_EVENTS = 8;
const MAX_SEED_SUFFIX_BYTES = 32_768;

/**
 * A covered root prefix stays sufficient when the entire extra suffix just
 * records completed enrollment. The native writer still checks the old prefix.
 */
export function isConversationKnowledgeSeedSuffix(
  page: SessionTranscriptRawDeltaResult,
  fromSeq: number,
  throughSeq: number,
): boolean {
  const count = throughSeq - fromSeq + 1;
  if (
    page.kind !== "page" ||
    !Number.isSafeInteger(count) ||
    count < 2 ||
    count > MAX_SEED_SUFFIX_EVENTS + 1 ||
    page.events.length !== count ||
    page.requiredBytes !== undefined
  ) {
    return false;
  }
  const first = page.events[0];
  let parent = asOptionalRecord(first?.event)?.id;
  if (first?.seq !== fromSeq || typeof parent !== "string" || !parent) {
    return false;
  }
  for (let index = 1; index < page.events.length; index++) {
    const row = page.events[index]!;
    const entry = asOptionalRecord(row.event);
    const details = asOptionalRecord(entry?.details);
    if (
      row.seq !== fromSeq + index ||
      entry?.type !== "custom_message" ||
      entry.customType !== CONVERSATION_KNOWLEDGE_SEED ||
      entry.display !== false ||
      typeof entry.id !== "string" ||
      !entry.id ||
      entry.parentId !== parent ||
      details?.version !== 1 ||
      details.complete !== true
    ) {
      return false;
    }
    parent = entry.id;
  }
  return true;
}

export function resolveConversationKnowledgeSeedSuffixRead(params: {
  agentId: string;
  sessionId: string;
  generation: string;
  fromSeq: number;
  throughSeq: number;
}) {
  const gap = params.throughSeq - params.fromSeq;
  if (!Number.isSafeInteger(gap) || gap < 1 || gap > MAX_SEED_SUFFIX_EVENTS) {
    return undefined;
  }
  return {
    cursor: createTranscriptRawDeltaCursor({
      agentId: params.agentId,
      sessionId: params.sessionId,
      generation: params.generation,
      // Include the already prepared boundary to prove the parent chain.
      lastSeq: params.fromSeq - 1,
    }),
    maxEvents: gap + 1,
    maxBytes: MAX_SEED_SUFFIX_BYTES,
  };
}
