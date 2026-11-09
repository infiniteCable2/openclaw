import {
  createReplySessionInitializationRevision,
  mergeConcurrentReplySessionMetadata,
} from "./session-accessor.entry-mutation.js";
import type { ReplySessionInitializationCommitResult } from "./session-accessor.types.js";
import type { ReplySessionInitializationUpsertDescriptor } from "./session-reset.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export function createStaleReplySessionInitializationResult(
  currentEntry: SessionEntry | undefined,
): ReplySessionInitializationCommitResult {
  return {
    ok: false,
    ...(currentEntry ? { currentEntry } : {}),
    reason: "stale-snapshot",
    revision: createReplySessionInitializationRevision(currentEntry),
  };
}

/** The typed reply descriptor serves today's builder and the later compound projection kernel. */
export function resolveReplySessionInitializationUpserts(
  descriptor: ReplySessionInitializationUpsertDescriptor,
  currentEntry: SessionEntry | undefined,
) {
  if (createReplySessionInitializationRevision(currentEntry) !== descriptor.expectedRevision) {
    return { kind: "stale" as const, currentEntry };
  }
  return {
    kind: "ready" as const,
    // Identity checks permit unrelated background metadata updates. Preserve those changes
    // without restoring fields that this reset deliberately cleared.
    entry: currentEntry
      ? mergeConcurrentReplySessionMetadata({
          currentEntry,
          preparedEntry: descriptor.entry,
          snapshotEntry: descriptor.snapshotEntry,
        })
      : descriptor.entry,
    retiredEntry: descriptor.retiredEntry,
  };
}
