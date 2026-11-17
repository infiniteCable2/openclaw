import type { InternalSessionEntry } from "../config/sessions/types.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import { readSessionListSelectionFacts } from "./session-list-target.js";
import type { Row } from "./session-row-projection-record.js";

/** Retain full row metadata while detaching only its immutable restart evidence. */
export function captureSessionRowEntry(entry: InternalSessionEntry): InternalSessionEntry {
  const enrollment = entry.conversationRecipientEnrollment;
  if (!enrollment || isDeeplyFrozenPlainData(enrollment)) {
    return entry;
  }
  return {
    ...entry,
    conversationRecipientEnrollment: freezeJsonSnapshot(structuredClone(enrollment)),
  };
}

/** Accepted facets retain their exact type and the row owner's canonical entry. */
export function alignSessionRowFactsEntry<T extends { entry: InternalSessionEntry }>(
  facts: T,
  entry: InternalSessionEntry | undefined,
): T {
  return entry && facts.entry !== entry ? { ...facts, entry } : facts;
}

export function create(
  target: Pick<Row, "agentId" | "key" | "storeTarget">,
  entry?: InternalSessionEntry,
): Row {
  const storedEntry = entry && captureSessionRowEntry(entry);
  return {
    ...target,
    storedEntry,
    sharingEntry: storedEntry,
    selection: readSessionListSelectionFacts(target.key, storedEntry),
    parents: new Set(),
    membership: new Set(),
    generation: Symbol("row"),
    databaseFactsRevision: 0,
  };
}
