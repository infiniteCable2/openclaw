import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("auto-reply/conversation-knowledge");

/** Correlate disposable readiness with native admission without recording dialogue. */
export function logConversationKnowledgeTransfer(params: {
  phase: "prepared" | "admitted";
  recipient: string;
  receipt: ConversationKnowledgeReference;
  offset: number;
  complete: boolean;
}) {
  if (!log.isEnabled("debug")) {
    return;
  }
  log.debug("Conversation knowledge transfer", {
    phase: params.phase,
    recipientHash: redactIdentifier(params.recipient),
    sourceHash: redactIdentifier(params.receipt.source.sessionId),
    contributionHash: redactIdentifier(conversationKnowledgeContributionId(params.receipt)),
    throughSeq: params.receipt.through.rawSeq,
    offset: params.offset,
    complete: params.complete,
  });
}

export type ConversationKnowledgeGap = {
  sourceSessionKey: string;
  throughEntryId: string;
  reason:
    | "source-access-unavailable"
    | "source-range-unverified"
    | "source-range-over-capacity"
    | "admission-deferred";
};

/** Keep source-specific diagnostics separate from knowledge admission and its authority. */
export function createConversationKnowledgeGapCollector() {
  const gaps: ConversationKnowledgeGap[] = [];
  return {
    gaps,
    gap: (
      receipt: { source: { sessionKey: string }; through: { entryId: string } },
      reason: ConversationKnowledgeGap["reason"],
    ) => {
      gaps.push({
        sourceSessionKey: receipt.source.sessionKey,
        throughEntryId: receipt.through.entryId,
        reason,
      });
    },
  };
}

/** Operational diagnostics only: never append status to a transcript or model context. */
export function logConversationKnowledgeDiagnostic(params: {
  recipient: string;
  gaps?: readonly ConversationKnowledgeGap[];
  pending?: "context-window" | "maintenance-deferred" | "snapshot-capacity";
  reason?:
    | "initial-history-not-yet-verified"
    | "preparation-deferred"
    | "original-participant-unconfirmed"
    | "private-destination-audience-unconfirmed";
}) {
  const gaps = params.gaps ?? [];
  if ((!gaps.length && !params.pending && !params.reason) || !log.isEnabled("debug")) {
    return;
  }
  const groups = new Map<string, ConversationKnowledgeGap & { ranges: number }>();
  for (const gap of gaps) {
    const key = JSON.stringify([gap.sourceSessionKey, gap.reason]);
    const previous = groups.get(key);
    groups.set(key, { ...gap, ranges: (previous?.ranges ?? 0) + 1 });
  }
  log.debug("Supplementary conversation catch-up deferred", {
    recipientHash: redactIdentifier(params.recipient),
    unresolvedRanges: gaps.length,
    gaps: [...groups.values()].slice(0, 3).map((gap) => ({
      sourceHash: redactIdentifier(gap.sourceSessionKey),
      endpointHash: redactIdentifier(gap.throughEntryId),
      reason: gap.reason,
      ranges: gap.ranges,
    })),
    ...(groups.size > 3 ? { additionalGapGroups: groups.size - 3 } : {}),
    ...(params.pending ? { pending: params.pending } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
  });
}
