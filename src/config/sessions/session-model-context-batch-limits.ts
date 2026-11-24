import type { SessionModelContextLimits } from "./session-history-read.types.js";

const MIB = 1024 * 1024;
export const MAX_SESSION_MODEL_CONTEXT_BATCH_RANGES = 8;

/** Larger groups get more total room, with a fixed ceiling for native scheduling. */
export function sessionModelContextBatchByteBudget(count: number): number {
  return Math.min(Math.max(count, 2) * 64 * MIB, 192 * MIB);
}

/** Scheduling bounds apply before either durable or process-held source dispatch. */
export function assertSessionModelContextBatchBudget(
  ranges: readonly { limits: SessionModelContextLimits }[],
): void {
  if (
    ranges.length > MAX_SESSION_MODEL_CONTEXT_BATCH_RANGES ||
    ranges.reduce((bytes, range) => {
      const max = range.limits.maxBytes;
      // The per-range validator reports invalid limits independently; they cannot hold bytes.
      return Number.isSafeInteger(max) && max > 0 ? bytes + max : bytes;
    }, 0) > sessionModelContextBatchByteBudget(ranges.length)
  ) {
    throw new RangeError("Model-context batch exceeds its scheduling budget");
  }
}
