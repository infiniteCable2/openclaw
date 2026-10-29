import type { SessionEntry } from "../../agents/sessions/session-manager-types.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";

/** Reuse completed native compaction, while keeping the review's evidence boundary exact. */
export function restoreExperienceReviewContextTail(
  historical: SessionManager,
  terminalEntryId: string,
  tail: readonly SessionEntry[] | undefined,
): SessionManager {
  if (!tail) {
    return historical;
  }
  const branch = historical.getBranch();
  const ids = new Set(branch.map((entry) => entry.id));
  let parentId = terminalEntryId;
  let hasCompaction = false;
  if (historical.getLeafId() !== terminalEntryId) {
    throw new SessionTranscriptReadFenceError("Review context does not end at its evidence anchor");
  }
  for (const entry of tail) {
    if (
      entry.parentId !== parentId ||
      ids.has(entry.id) ||
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "branch_summary" ||
      entry.type === "reset"
    ) {
      throw new SessionTranscriptReadFenceError(
        "Review maintenance tail changed its source boundary",
      );
    }
    ids.add(entry.id);
    if (entry.type === "compaction") {
      if (!entry.summary.trim() || !ids.has(entry.firstKeptEntryId)) {
        throw new SessionTranscriptReadFenceError(
          "Review compaction has no retained context boundary",
        );
      }
      hasCompaction = true;
    }
    parentId = entry.id;
  }
  if (!hasCompaction) {
    throw new SessionTranscriptReadFenceError(
      "Review maintenance tail has no completed compaction",
    );
  }
  return SessionManager.fromEntries(
    [historical.getHeader(), ...branch, ...tail],
    historical.getCwd(),
  );
}
