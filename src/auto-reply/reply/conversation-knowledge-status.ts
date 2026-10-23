import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";

export type ConversationKnowledgeGap = {
  sourceSessionKey: string;
  throughEntryId: string;
  reason: "source-range-unverified" | "source-range-over-capacity" | "admission-deferred";
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

/** Describe only authorized supplementary history, never invalidate the current dialogue. */
export function conversationKnowledgeCoverageNotice(params: {
  gaps: readonly ConversationKnowledgeGap[];
  pending?: "context-window" | "maintenance-deferred";
}): RuntimeContextFragment[] {
  if (params.gaps.length === 0 && !params.pending) {
    return [];
  }
  const groups = new Map<string, ConversationKnowledgeGap & { ranges: number }>();
  for (const gap of params.gaps) {
    const key = JSON.stringify([gap.sourceSessionKey, gap.reason]);
    const previous = groups.get(key);
    groups.set(key, { ...gap, ranges: (previous?.ranges ?? 0) + 1 });
  }
  return [
    {
      kind: "conversation-data",
      text: JSON.stringify({
        capability: "related-conversation-context",
        state: params.gaps.length > 0 ? "partial" : "pending",
        scope: "supplementary-history-only",
        unresolvedRanges: params.gaps.length,
        gaps: [...groups.values()].slice(0, 3),
        ...(groups.size > 3 ? { additionalGapGroups: groups.size - 3 } : {}),
        ...(params.pending ? { pending: params.pending } : {}),
        guidance:
          "Continue the current dialogue normally. Unverified ranges need source revalidation; " +
          "deferred additions are retried on later turns. Use already-authorized history/search " +
          "only for relevant missing detail; do not repeatedly fetch or reinject the same history.",
      }),
    },
  ];
}
