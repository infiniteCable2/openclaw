import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { createAbortError } from "../../infra/abort-signal.js";

export function assertReplyPreprocessingActive(
  options: { abortSignal?: AbortSignal; assertSourceCurrent?: SessionSourceAssertion } | undefined,
): void {
  options?.assertSourceCurrent?.();
  const signal = options?.abortSignal;
  if (signal?.aborted) {
    throw createAbortError("Reply canceled during preprocessing", { cause: signal.reason });
  }
}

/** Async preparation must publish only under its original input's still-live source. */
export async function withReplySourceCurrent<T>(
  assertSourceCurrent: SessionSourceAssertion | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  assertSourceCurrent?.();
  const result = await run();
  assertSourceCurrent?.();
  return result;
}
