import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
  conversationKnowledgeOrigin,
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
  type ConversationKnowledgeFrontier,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import type { TranscriptEvent } from "./session-accessor.types.js";

/** The current origin's latest completed report owns its observed progress, even when empty. */
export function selectConversationKnowledgeObserved(
  events: readonly TranscriptEvent[],
  source: ConversationKnowledgeReference["source"],
): ConversationKnowledgeFrontier[] {
  const currentOrigin = conversationKnowledgeOrigin(source);
  for (let index = events.length - 1; index >= 0; index--) {
    const record = asOptionalRecord(events[index]);
    const receipt =
      record?.type === "custom_message" && record.customType === CONVERSATION_KNOWLEDGE_REPORT
        ? readConversationKnowledgeReceipt(record.details)
        : undefined;
    if (receipt?.origin === currentOrigin) {
      return receipt.observed ?? [];
    }
  }
  return [];
}

/** Keep every distinct admitted endpoint in report order, not only a source's latest turn. */
export function selectConversationKnowledgeReceipts(
  events: readonly TranscriptEvent[],
  currentSessionId: string,
  currentSessionKey?: string,
  consumerMode: "native" | "branches" = "branches",
) {
  const selected = new Map<string, ConversationKnowledgeReference>();
  const retired = new Set<string>();
  const incarnationByKey = new Map<string, string>();
  for (const event of events) {
    const record = asOptionalRecord(event);
    if (record?.type !== "custom_message") {
      continue;
    }
    const receipt =
      record.customType === CONVERSATION_KNOWLEDGE_REPORT
        ? readConversationKnowledgeReceipt(record.details)
        : record.customType === CONVERSATION_UTTERANCE_REPORT
          ? readConversationUtteranceObservation(record.details)
          : undefined;
    if (
      !receipt ||
      receipt.source.sessionId === currentSessionId ||
      receipt.source.sessionKey === currentSessionKey
    ) {
      continue;
    }
    const sourceKey = JSON.stringify([receipt.source.agentId, receipt.source.sessionKey]);
    const incarnation = conversationKnowledgeOrigin(receipt.source);
    const oldOrigin = incarnationByKey.get(sourceKey);
    if (oldOrigin && oldOrigin !== incarnation) {
      for (const [origin, previous] of selected) {
        if (
          previous.source.agentId === receipt.source.agentId &&
          previous.source.sessionKey === receipt.source.sessionKey
        ) {
          selected.delete(origin);
        }
      }
    }
    incarnationByKey.set(sourceKey, incarnation);
    const endpoint = JSON.stringify([
      receipt.origin,
      receipt.through.generation,
      receipt.through.rawSeq,
      receipt.through.entryId,
    ]);
    if (receipt.retirement) {
      retired.add(endpoint);
      selected.delete(endpoint);
    } else if (!retired.has(endpoint) && !selected.has(endpoint)) {
      // Generations are incomparable. Keep older endpoints for explicit gap handling
      // rather than letting compaction silently acknowledge an unread contribution.
      selected.set(endpoint, receipt);
    }
  }
  // Deduplicate and reconcile incarnations before filtering: a later duplicate
  // cannot relabel the same saved occurrence to make it visible in native mode.
  return [...selected.values()].filter(
    (receipt) => consumerMode === "branches" || receipt.sourceMode === "branches",
  );
}
