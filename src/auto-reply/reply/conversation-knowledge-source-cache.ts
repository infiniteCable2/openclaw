import type { projectConversationKnowledge } from "../../config/sessions/conversation-knowledge.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { SessionTranscriptModelContext } from "../../config/sessions/session-history-read.types.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-transcript-context-version.types.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";

export type PreparedConversationKnowledgePacket = {
  part: NonNullable<ReturnType<typeof projectConversationKnowledge>>;
  version: SessionTranscriptContextVersion;
  through: TranscriptEntryAnchor;
  from?: TranscriptEntryAnchor;
};

/** Disposable source bytes, never a retained read grant or recipient admission receipt. */
export function createConversationKnowledgeSourceCache(maxBytes = 4 * 1024 * 1024) {
  const entries = new Map<
    string,
    { value: SessionTranscriptModelContext; bytes: number; contributionId: string }
  >();
  const staged = new Map<
    string,
    { value: PreparedConversationKnowledgePacket; bytes: number; contributionId: string }
  >();
  let bytes = 0;
  let stagedBytes = 0;
  let revision = 0;
  let clearEpoch = 0;
  const remove = (key: string) => {
    const old = entries.get(key);
    if (old) {
      bytes -= old.bytes;
      entries.delete(key);
      revision++;
    }
  };
  const stagedKey = (id: string, offset: number) => JSON.stringify([id, offset]);
  return {
    get revision() {
      return revision;
    },
    hasContribution(id: string) {
      return (
        [...entries.values()].some((entry) => entry.contributionId === id) ||
        [...staged.values()].some((entry) => entry.contributionId === id)
      );
    },
    /** Pending packets have their own bounded budget and never evict earlier unsent packets. */
    stage(id: string, offset: number, value: PreparedConversationKnowledgePacket): boolean {
      const key = stagedKey(id, offset);
      if (staged.has(key)) {
        return true;
      }
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size > maxBytes - stagedBytes) {
        return false;
      }
      staged.set(key, { value: structuredClone(value), bytes: size, contributionId: id });
      stagedBytes += size;
      revision++;
      return true;
    },
    peek(id: string, offset: number): PreparedConversationKnowledgePacket | undefined {
      const value = staged.get(stagedKey(id, offset))?.value;
      return value && structuredClone(value);
    },
    consume(id: string, offset: number) {
      const key = stagedKey(id, offset);
      const old = staged.get(key);
      if (old) {
        staged.delete(key);
        stagedBytes -= old.bytes;
        revision++;
      }
    },
    invalidateContribution(id: string) {
      for (const [key, entry] of entries) {
        if (entry.contributionId === id) {
          remove(key);
        }
      }
      for (const [key, entry] of staged) {
        if (entry.contributionId === id) {
          staged.delete(key);
          stagedBytes -= entry.bytes;
          revision++;
        }
      }
    },
    clear() {
      entries.clear();
      staged.clear();
      bytes = 0;
      stagedBytes = 0;
      revision++;
      clearEpoch++;
    },
    async read(params: {
      contributionId: string;
      target: SessionTranscriptRuntimeTarget;
      through: TranscriptEntryAnchor;
      from?: TranscriptEntryAnchor;
      signal?: AbortSignal;
      assertCurrent(): void;
      load?: () => Promise<SessionTranscriptModelContext>;
    }): Promise<SessionTranscriptModelContext | undefined> {
      params.assertCurrent();
      params.signal?.throwIfAborted();
      const key = JSON.stringify([
        params.contributionId,
        params.target.agentId,
        params.target.storePath,
        params.target.sessionKey,
        params.target.sessionId,
        params.through,
        params.from,
      ]);
      const cached = entries.get(key);
      if (cached?.value.version) {
        let valid = false;
        try {
          await readSessionTranscriptAnchorsAsync(
            params.target,
            {
              entryIds: [],
              contextValidation: {
                version: cached.value.version,
                through: params.through,
                from: params.from,
              },
            },
            params.signal,
            (facts) => {
              params.assertCurrent();
              valid = facts.contextValidated === true;
            },
          );
        } catch (error) {
          if (!(error instanceof SessionTranscriptReadFenceError)) {
            throw error;
          }
        }
        params.assertCurrent();
        params.signal?.throwIfAborted();
        if (valid) {
          if (entries.get(key) === cached) {
            entries.delete(key);
            entries.set(key, cached);
          }
          return cached.value;
        }
        if (entries.get(key) === cached) {
          remove(key);
        }
      }
      if (!params.load) {
        return undefined;
      }
      const epoch = clearEpoch;
      const value = await params.load();
      params.assertCurrent();
      params.signal?.throwIfAborted();
      const size = Buffer.byteLength(JSON.stringify(value));
      // Cache capacity changes only preparation cost, never delivered knowledge coverage.
      if (value.version && size <= maxBytes && epoch === clearEpoch) {
        remove(key);
        for (const oldKey of entries.keys()) {
          if (bytes + size <= maxBytes) {
            break;
          }
          remove(oldKey);
        }
        entries.set(key, { value, bytes: size, contributionId: params.contributionId });
        bytes += size;
        revision++;
      }
      return value;
    },
  };
}

export type ConversationKnowledgeSourceCache = ReturnType<
  typeof createConversationKnowledgeSourceCache
>;
