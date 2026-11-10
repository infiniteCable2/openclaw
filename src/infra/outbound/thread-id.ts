// Thread id helpers normalize channel topic/thread identifiers before payload
// construction and route matching.
import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";

/** Normalizes channel thread/topic ids before outbound payload construction. */
export function normalizeOutboundThreadId(value?: string | number | null): string | undefined {
  return normalizeOptionalStringifiedId(value);
}

/** Keeps the delivery id's native type alongside the normalized session-key id. */
export function resolveThreadAwareOutboundCandidate(
  threadId?: string | number | null,
): { routeThreadId: string | number; sessionThreadId: string } | undefined {
  const sessionThreadId = normalizeOutboundThreadId(threadId);
  if (sessionThreadId === undefined) {
    return undefined;
  }
  return {
    routeThreadId: typeof threadId === "number" ? threadId : sessionThreadId,
    sessionThreadId,
  };
}
