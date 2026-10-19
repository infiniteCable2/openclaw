import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";

export type ConversationKnowledgeIngestionMaintenance = {
  contextLimits?: { maxBytes: number; maxEvents: number };
  maintainContext(
    sources: SessionSourceAssertion,
    packetIds?: readonly string[],
    pendingText?: string,
  ): Promise<void | { compacted: boolean; complete: boolean }>;
};

/** Pace imported packets while tracking which exact additions native hydration must retain. */
export function createConversationKnowledgeIngestion(params: {
  maintenance: ConversationKnowledgeIngestionMaintenance;
  captureSources(): SessionSourceAssertion;
}) {
  let admittedChars = 0;
  const packetIds = new Set<string>();
  let incomplete = false;
  let deferred = false;
  const maintain = async (pendingText?: string) => {
    const result = await params.maintenance.maintainContext(
      params.captureSources(),
      [...packetIds],
      pendingText,
    );
    incomplete = result?.complete === false;
    if (result?.compacted) {
      // The native rewrite replaces these packet carriers with the accepted summary.
      packetIds.clear();
    }
    admittedChars = 0;
    return result;
  };
  return {
    get incomplete() {
      return incomplete || deferred;
    },
    coverageNotice(sourceUnavailable: boolean): RuntimeContextFragment[] {
      return sourceUnavailable || incomplete || deferred
        ? [
            {
              kind: "conversation-data",
              text: "Related-conversation catch-up is incomplete: an exact source range is not available in the current native context. Do not assume all related history has been incorporated; use authorized history/search for missing detail.",
            },
          ]
        : [];
    },
    async tryPacket(text: string, write: () => Promise<string | undefined>) {
      if (deferred) {
        return false;
      }
      if (admittedChars >= 24_000) {
        await maintain();
      }
      let id = await write();
      if (id === undefined) {
        // The native writer proved NO WRITE. Compact only if the real native
        // token check, including this prospective text, requires it.
        const result = await maintain(text);
        if (result?.compacted) {
          id = await write();
        }
      }
      if (id === undefined) {
        deferred = true;
        return false;
      }
      packetIds.add(id);
      admittedChars += text.length;
      return true;
    },
    async finish() {
      // Existing history without actual catch-up uses ordinary native reply preflight.
      if (admittedChars > 0) {
        await maintain();
      }
    },
  };
}
