import type { SessionModelContextLimits } from "./session-history-read.types.js";

/** Scheduling bounds apply before either durable or process-held source dispatch. */
export function assertSessionModelContextBatchBudget(
  ranges: readonly { limits: SessionModelContextLimits }[],
): void {
  if (
    ranges.length > 2 ||
    ranges.reduce((bytes, range) => bytes + range.limits.maxBytes, 0) > 128 * 1024 * 1024
  ) {
    throw new RangeError("Model-context batch exceeds its scheduling budget");
  }
}
