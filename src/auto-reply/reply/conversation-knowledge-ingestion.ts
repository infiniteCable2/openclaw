import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";

export type ConversationKnowledgeMaintenanceResult = {
  compacted: boolean;
  complete: boolean;
  pending?: "maintenance-deferred";
};

export type ConversationKnowledgeIngestionMaintenance = {
  contextLimits?: { maxBytes: number; maxEvents: number };
  maintainContext(
    sources: SessionSourceAssertion,
    packetIds?: readonly string[],
    pendingText?: string,
  ): Promise<void | ConversationKnowledgeMaintenanceResult>;
};

/** Pace imported packets while tracking which exact additions native hydration must retain. */
export function createConversationKnowledgeIngestion(params: {
  maintenance: ConversationKnowledgeIngestionMaintenance;
  captureSources(): SessionSourceAssertion;
  /** Native uncompacted carriers, not all historical durable-copy receipts. */
  activePacketIds?: readonly string[];
}) {
  let admittedChars = 0;
  let admittedSinceMaintenance = false;
  const packetIds = new Set<string>(params.activePacketIds);
  let incomplete = false;
  let admissionDeferred = false;
  let maintenanceDeferred = false;
  const maintain = async (pendingText?: string) => {
    if (maintenanceDeferred) {
      return { compacted: false, complete: false, pending: "maintenance-deferred" } as const;
    }
    const result = await params.maintenance.maintainContext(
      params.captureSources(),
      [...packetIds],
      pendingText,
    );
    incomplete = result?.complete === false;
    maintenanceDeferred = result?.pending === "maintenance-deferred";
    if (result?.compacted) {
      // The native rewrite replaces these packet carriers with the accepted summary.
      packetIds.clear();
    }
    admittedChars = 0;
    admittedSinceMaintenance = false;
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
    async tryPacket(text: string, write: () => Promise<string | undefined>) {
      if (admittedChars >= 24_000) {
        await maintain();
      }
      let id = await write();
      if (id === undefined) {
        // The native writer proved NO WRITE. Compact only if the real native
        // token check, including this prospective text, requires it.
        // One refused addition must not starve independent, smaller contributions.
        // Do not repeat failed maintenance for every remaining source this turn.
        const result = admissionDeferred ? undefined : await maintain(text);
        if (result?.compacted) {
          id = await write();
        }
      }
      if (id === undefined) {
        admissionDeferred = true;
        return false;
      }
      packetIds.add(id);
      admittedChars += text.length;
      admittedSinceMaintenance = true;
      return true;
    },
    async finish() {
      // Unchanged history belongs to the foreground's native budget preflight.
      // Check this pass's admitted additions, retaining all active carrier IDs.
      if (admittedSinceMaintenance) {
        await maintain();
      }
    },
  };
}
