import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const completeSummary = resolveGlobalSingleton(
  Symbol.for("openclaw.completeCompactionSummary"),
  () => new AsyncLocalStorage<boolean>(),
);

/** Catch-up must retain its original packets if any summarization chunk is omitted. */
export function withCompleteCompactionSummary<T>(operation: () => Promise<T>): Promise<T> {
  return completeSummary.run(true, operation);
}

export function requiresCompleteCompactionSummary(): boolean {
  return completeSummary.getStore() === true;
}

/** Native lossy finalization stays available except during explicitly complete catch-up. */
export function reportCompactionSummaryLosses(
  losses: ReadonlySet<string>,
  warn: (message: string) => void,
): void {
  if (losses.size === 0) {
    return;
  }
  if (requiresCompleteCompactionSummary()) {
    throw new Error("Complete catch-up summary exceeds the finalized artifact budget");
  }
  warn(`Compaction safeguard: finalized artifact truncated; loss=${[...losses].join(",")}`);
}
