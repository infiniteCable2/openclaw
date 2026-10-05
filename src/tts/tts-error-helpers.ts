import type { TtsProvider } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { redactSensitiveText } from "../logging/redact.js";

// Fetch and provider deadlines use several error shapes; normalize them here.
export function isTtsTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    /\b(?:timed out|deadline exceeded|HTTP 408)\b/iu.test(err.message)
  );
}

export function formatTtsProviderError(provider: TtsProvider, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  if (isTtsTimeoutError(error)) {
    return `${provider}: request timed out`;
  }
  return `${provider}: ${redactSensitiveText(error.message)}`;
}

export function sanitizeTtsErrorForLog(err: unknown): string {
  const raw = formatErrorMessage(err);
  return redactSensitiveText(raw).replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/** Projection diagnostics remain primary when releasing an already-created synthesis also fails. */
export async function throwTtsProjectionError(
  error: unknown,
  cleanup: () => void | Promise<void>,
): Promise<never> {
  const [result] = await Promise.allSettled([Promise.resolve().then(cleanup)]);
  if (result.status === "rejected") {
    throw new AggregateError([error, result.reason], formatErrorMessage(error), { cause: error });
  }
  throw error;
}
