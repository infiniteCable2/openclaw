import { convertToLlm, type CustomMessage } from "../sessions/messages.js";
import { pruneProcessedHistoryImages } from "./run/history-image-prune.js";
import { shouldPreemptivelyCompactBeforePrompt } from "./run/preemptive-compaction.js";

/**
 * Explicit ingestion-budget maintenance uses the native outgoing prompt estimate.
 * Unlike the ordinary prompt's diagnostic-only raw-history maximum, the caller
 * requests this check before continuing a potentially unbounded packet import.
 */
export function prepareCompactionBudgetPreflight(
  params: Parameters<typeof shouldPreemptivelyCompactBeforePrompt>[0] & {
    pendingMessages?: readonly CustomMessage[];
  },
) {
  const { pendingMessages, ...budget } = params;
  const history = pruneProcessedHistoryImages(params.messages) ?? params.messages;
  return shouldPreemptivelyCompactBeforePrompt({
    ...budget,
    // Native live-boundary additions use the same custom-to-LLM projection.
    // Pending media is unprocessed; prune only the already durable history.
    messages: pendingMessages?.length
      ? [...history, ...convertToLlm([...pendingMessages])]
      : history,
  });
}
