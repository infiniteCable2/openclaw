import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const completeSummary = resolveGlobalSingleton(
  Symbol.for("openclaw.completeCompactionSummary"),
  () => new AsyncLocalStorage<boolean>(),
);

/** Branch maintenance requires a generated summary, using the native bounded summarizer. */
export function withCompleteCompactionSummary<T>(operation: () => Promise<T>): Promise<T> {
  return completeSummary.run(true, operation);
}

export function requiresCompleteCompactionSummary(): boolean {
  return completeSummary.getStore() === true;
}

/** Native sampling/fitting is allowed; a no-summary fallback cannot cover branch knowledge. */
export function assertGeneratedCompactionSummary(): void {
  if (requiresCompleteCompactionSummary()) {
    throw new Error("Conversation knowledge maintenance requires a generated summary");
  }
}
