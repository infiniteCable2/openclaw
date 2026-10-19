import { pruneProcessedHistoryImages } from "./run/history-image-prune.js";
import { shouldPreemptivelyCompactBeforePrompt } from "./run/preemptive-compaction.js";

/**
 * Explicit ingestion-budget maintenance uses the native outgoing prompt estimate.
 * Unlike the ordinary prompt's diagnostic-only raw-history maximum, the caller
 * requests this check before continuing a potentially unbounded packet import.
 */
export function prepareCompactionBudgetPreflight(
  params: Parameters<typeof shouldPreemptivelyCompactBeforePrompt>[0],
) {
  return shouldPreemptivelyCompactBeforePrompt({
    ...params,
    messages: pruneProcessedHistoryImages(params.messages) ?? params.messages,
  });
}
