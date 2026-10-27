import type { CustomMessage } from "../../agents/sessions/messages.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";

export type ConversationKnowledgeMaintenanceResult = {
  compacted: boolean;
  complete: boolean;
  pending?: "maintenance-deferred";
  /** Positive native prospective-budget decision for the exact supplied messages. */
  canAdmitPending?: boolean;
};

export type ConversationKnowledgeIngestionMaintenance = {
  contextLimits?: { maxBytes: number; maxEvents: number };
  maintainContext(
    sources: SessionSourceAssertion,
    packetIds?: readonly string[],
    pendingText?: string,
    pendingMessages?: readonly CustomMessage[],
    options?: { checkOnly?: boolean },
  ): Promise<void | ConversationKnowledgeMaintenanceResult>;
};

/** Pace imported packets while tracking which exact additions native hydration must retain. */
export function createConversationKnowledgeIngestion(params: {
  maintenance: ConversationKnowledgeIngestionMaintenance;
  captureSources(): SessionSourceAssertion;
  /** Native uncompacted carriers, not all historical durable-copy receipts. */
  activePacketIds?: readonly string[];
}) {
  const packetIds = new Set<string>(params.activePacketIds);
  let incomplete = false;
  let admissionDeferred = false;
  let maintenanceDeferred = false;
  const maintain = async (
    pendingText?: string,
    pendingMessages?: readonly CustomMessage[],
    options?: { checkOnly?: boolean },
  ): Promise<void | ConversationKnowledgeMaintenanceResult> => {
    if (maintenanceDeferred) {
      return { compacted: false, complete: false, pending: "maintenance-deferred" } as const;
    }
    const source = params.captureSources();
    const result = await (options
      ? params.maintenance.maintainContext(
          source,
          [...packetIds],
          pendingText,
          pendingMessages,
          options,
        )
      : pendingMessages
        ? params.maintenance.maintainContext(source, [...packetIds], pendingText, pendingMessages)
        : params.maintenance.maintainContext(source, [...packetIds], pendingText));
    incomplete = result?.complete === false;
    maintenanceDeferred = result?.pending === "maintenance-deferred";
    if (result?.compacted) {
      // The native rewrite replaces these packet carriers with the accepted summary.
      packetIds.clear();
    }
    return result;
  };
  return {
    get incomplete() {
      return incomplete || admissionDeferred;
    },
    get pending() {
      return maintenanceDeferred
        ? ("maintenance-deferred" as const)
        : incomplete
          ? ("context-window" as const)
          : undefined;
    },
    async tryBatch(
      messages: readonly CustomMessage[],
      write: (count: number) => Promise<{
        accepted: number;
        appended: number;
        deferred: boolean;
        packetIds: string[];
      }>,
    ) {
      const deferred = { accepted: 0, appended: 0, deferred: true, packetIds: [] as string[] };
      if (!messages.length) {
        return { ...deferred, deferred: false };
      }
      let count = messages.length;
      let decision = await maintain(undefined, messages, { checkOnly: true });
      // Only an explicit native over-budget result permits a bounded shrink.
      // Missing decisions, unavailable history and revoked sources never retry.
      while (decision?.canAdmitPending === false && decision.complete && count > 1) {
        count = Math.max(1, Math.floor(count / 2));
        decision = await maintain(undefined, messages.slice(0, count), { checkOnly: true });
      }
      if (decision?.canAdmitPending === false && decision.complete && count === 1) {
        decision = await maintain(undefined, messages.slice(0, 1));
        if (decision?.compacted) {
          // Summaries contain only durable history, never these pending messages.
          decision = await maintain(undefined, messages.slice(0, 1), { checkOnly: true });
        }
      }
      if (decision?.canAdmitPending !== true || decision.complete !== true) {
        admissionDeferred = true;
        return deferred;
      }
      const result = await write(count);
      for (const id of result.packetIds) {
        packetIds.add(id);
      }
      // The exact prospective batch already passed native pressure. Accepted
      // prefixes remain durable even if the writer's byte/event fence defers its tail.
      admissionDeferred ||= result.deferred || count < messages.length;
      return count < messages.length ? { ...result, deferred: true } : result;
    },
  };
}
