import type { AgentMessage, SessionTreeEntry } from "@openclaw/agent-core";
import { iterateSessionContextEntries } from "../../../packages/agent-core/src/harness/session/session.js";
import { classifyToolUseResultPairing } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

/** The snapshot owner validates both physical anchors before passing navigation here. */
export function selectContributionModelContextEntries<T extends SessionTreeEntry & { seq: number }>(
  entries: readonly T[],
  from: TranscriptEntryAnchor,
): T[] {
  const start = entries.findIndex((entry) => entry.id === from.entryId);
  const contextEntries = Array.from(iterateSessionContextEntries(entries));
  if (
    start < 0 ||
    !contextEntries.some(({ entry }) => entry.id === from.entryId) ||
    entries.slice(start).some((entry) => entry.type === "compaction" || entry.type === "reset")
  ) {
    throw new SessionTranscriptReadFenceError(
      "Contribution start is outside the selected uncompacted transcript range",
    );
  }
  const selected = entries.slice(start);
  const messages = contextEntries.flatMap(({ entry }) =>
    entry.type === "message" ? [entry.message] : [],
  );
  const selectedMessages = contextEntries
    .filter(({ entry }) => entry.seq >= from.rawSeq)
    .flatMap(({ entry }) => (entry.type === "message" ? [entry.message] : []));
  const originalOwners = new Map<AgentMessage, AgentMessage>();
  const selectedOwners = new Map<AgentMessage, AgentMessage>();
  for (const [view, owners] of [
    [messages, originalOwners],
    [selectedMessages, selectedOwners],
  ] as const) {
    for (const frame of classifyToolUseResultPairing(view).frames) {
      for (const { sourceResult } of frame.occurrences) {
        if (sourceResult) owners.set(sourceResult, frame.assistant);
      }
    }
  }
  if (
    selectedMessages.some(
      (message) =>
        message.role === "toolResult" &&
        originalOwners.get(message) !== selectedOwners.get(message),
    )
  ) {
    throw new SessionTranscriptReadFenceError(
      "Contribution start would remove a retained tool result's owner",
    );
  }
  // Navigation alone selected this exact ancestor range. Older messages,
  // headers and compaction summaries must never become acquired payloads.
  return selected;
}
