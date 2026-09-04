import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Upgrade-only detection: removing a retired admission marker can activate its old sink. */
export function hasRetiredNullAgentConfig(raw: unknown): boolean {
  if (!isRecord(raw) || !isRecord(raw.agents)) {
    return false;
  }
  const entries = isRecord(raw.agents.entries) ? Object.values(raw.agents.entries) : [];
  const legacyList = Array.isArray(raw.agents.list) ? raw.agents.list : [];
  return [...entries, ...legacyList].some(
    (entry) => isRecord(entry) && Object.hasOwn(entry, "nullAgent"),
  );
}
