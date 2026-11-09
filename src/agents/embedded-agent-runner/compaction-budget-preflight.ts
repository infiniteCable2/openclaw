import { convertToLlm, type CustomMessage } from "../sessions/messages.js";
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
  return shouldPreemptivelyCompactBeforePrompt({
    ...budget,
    // Preserve the native replay prefix, including images until its compaction
    // boundary. Pending knowledge uses the same custom-to-LLM projection.
    messages: pendingMessages?.length
      ? [...params.messages, ...convertToLlm([...pendingMessages])]
      : params.messages,
  });
}
