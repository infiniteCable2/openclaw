import { isDeepStrictEqual } from "node:util";
import { LruCache } from "../../infra/lru-cache.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";

export const MAX_COMMITTED_INITIAL_PROGRESS_BYTES = 4 * 1024 * 1024;

export type CommittedConversationInitialProgress = {
  byteLength: number;
  branch: ConversationKnowledgeBranch;
  source: CapturedSessionEntryReadSource;
  version: SessionTranscriptContextVersion;
  reports: readonly TranscriptEvent[];
};

const initialProgress = new LruCache<CommittedConversationInitialProgress>(16, {
  maxBytes: MAX_COMMITTED_INITIAL_PROGRESS_BYTES,
  sizeOf: ({ byteLength }) => byteLength,
});

function key(branch: ConversationKnowledgeBranch, source: CapturedSessionEntryReadSource) {
  return JSON.stringify([
    source.agentId,
    source.path,
    source.databaseIdentity,
    source.databaseBirthtime,
    branch.agentId,
    branch.storePath,
    branch.sessionKey,
    branch.sessionId,
    branch.lifecycleRevision,
    branch.root.sessionKey,
    branch.root.sessionId,
    branch.root.lifecycleRevision,
  ]);
}

/** Metadata from a successful native creation commit, never a grant to read history. */
export function retainCommittedConversationInitialProgress(
  receipt: CommittedConversationInitialProgress,
) {
  if (
    !receipt.source.databaseIdentity ||
    !Number.isSafeInteger(receipt.byteLength) ||
    receipt.byteLength <= 0 ||
    receipt.byteLength > MAX_COMMITTED_INITIAL_PROGRESS_BYTES
  ) {
    return;
  }
  initialProgress.set(key(receipt.branch, receipt.source), receipt);
}

export function takeCommittedConversationInitialProgress(
  branch: ConversationKnowledgeBranch,
  source: CapturedSessionEntryReadSource,
  version: SessionTranscriptContextVersion,
): readonly TranscriptEvent[] | undefined {
  if (!source.databaseIdentity) {
    return undefined;
  }
  const cacheKey = key(branch, source);
  const value = initialProgress.peek(cacheKey);
  if (value) {
    initialProgress.delete(cacheKey);
    if (isDeepStrictEqual(value.version, version)) {
      return value.reports;
    }
  }
  return undefined;
}
