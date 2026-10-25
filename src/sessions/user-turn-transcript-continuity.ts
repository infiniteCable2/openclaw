import { readPreparedSessionEntryPublicationSource } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { readPreparedSessionTranscriptChange } from "../config/sessions/session-transcript-authority.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { sessionChanges } from "./session-row-changes.js";
import { getUserTurnTranscriptAdmissionOwner } from "./user-turn-transcript-admission.js";
import type { UserTurnTranscriptRecorder } from "./user-turn-transcript.types.js";

/** One active native turn, not a global recorder registry or a source-read grant. */
export function retainUserTurnTranscriptContinuity(params: {
  recorder?: UserTurnTranscriptRecorder;
  source: { agentId: string; sessionKey: string; sessionId: string; storePath?: string };
  assertCurrent(): void;
}): () => void {
  const owner = params.recorder && getUserTurnTranscriptAdmissionOwner(params.recorder);
  const { source } = params;
  if (!owner || !source.storePath) {
    return () => {};
  }
  const physical = readDatabasePathIdentitySync(source.storePath);
  if (!physical.key.startsWith("file:")) {
    return () => {};
  }
  const release = sessionChanges.subscribeFacts((change) => {
    if (
      !("sessionKey" in change) ||
      change.sessionKey !== source.sessionKey ||
      (change.agentId !== undefined && change.agentId !== source.agentId)
    ) {
      return;
    }
    const committedSource = readPreparedSessionEntryPublicationSource(change);
    if (committedSource.identity !== physical.key.slice("file:".length)) {
      return;
    }
    if (change.factsInvalidated) {
      // A failure notification retains provenance, not usable committed authority.
      release();
      return;
    }
    const fact = readPreparedSessionTranscriptChange(change);
    const admission = owner.receipt();
    const message = owner.message();
    if (
      fact?.kind !== "postimage" ||
      !fact.value.unchangedPrefix ||
      !fact.value.generation ||
      fact.value.needsRebuild !== 0 ||
      fact.value.sessionId !== source.sessionId ||
      !admission ||
      !message ||
      admission.agentId !== source.agentId ||
      admission.sessionKey !== source.sessionKey ||
      admission.sessionId !== source.sessionId ||
      admission.storePath !== physical.canonicalPath ||
      admission.generation !== fact.value.unchangedPrefix.previousGeneration ||
      admission.rawSeq >= fact.value.unchangedPrefix.beforeRawSeq
    ) {
      return;
    }
    // A matching committed mapping alone cannot renew a revoked run's custody.
    try {
      params.assertCurrent();
    } catch {
      // Optional continuity must not invalidate another input's legitimate COMMIT.
      release();
      return;
    }
    owner.refresh({ ...admission, generation: fact.value.generation }, message);
  });
  return release;
}
