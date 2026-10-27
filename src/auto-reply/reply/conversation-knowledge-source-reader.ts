import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-packets.js";
import type {
  ConversationKnowledgeBranch,
  NativeKnowledgeRootEvidence,
} from "../../config/sessions/conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import type { SessionTranscriptModelContextRangeResult } from "../../config/sessions/session-accessor.sqlite-model-context.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import {
  readSessionTranscriptModelContextAsync,
  readSessionTranscriptModelContextsAsync,
} from "../../config/sessions/session-transcript-context-read.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareTranscriptReadAuthority } from "../../gateway/session-transcript-read-authority.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { prepareConversationKnowledgeBranchFacts } from "./conversation-knowledge-authority.js";
import type { ConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";

export type ConversationKnowledgeHeldSource = {
  grant: Awaited<ReturnType<typeof prepareTranscriptReadAuthority>>;
  facts?: Awaited<ReturnType<typeof prepareConversationKnowledgeBranchFacts>>;
  origin?: string;
};

/**
 * Prepare native source grants and hydrate only the current and adjacent range.
 * The caller owns retained grants, revocation and cleanup; this closure owns
 * only disposable look-ahead prepared under those exact grants.
 */
export function createConversationKnowledgeSourceReader(params: {
  branch: ConversationKnowledgeBranch;
  originalParticipant: SessionParticipantIdentity;
  destinationAudience?: ConversationPrivateAudience;
  rootEvidence?: NativeKnowledgeRootEvidence;
  targetFacts: Awaited<ReturnType<typeof prepareConversationKnowledgeBranchFacts>>;
  assertCurrent: SessionSourceAssertion;
  getRuntimeConfig: () => OpenClawConfig;
  signal?: AbortSignal;
  sourceCache?: ConversationKnowledgeSourceCache;
  hasRetainedContribution(contributionId: string): boolean;
  reads: ConversationKnowledgeHeldSource[];
  drop: (read: ConversationKnowledgeHeldSource) => void;
}) {
  const { branch, originalParticipant, targetFacts, reads, drop } = params;
  const prepareSource = async (receipt: ConversationKnowledgeReference) => {
    const contributionId = conversationKnowledgeContributionId(receipt);
    let grant: Awaited<ReturnType<typeof prepareTranscriptReadAuthority>>;
    try {
      grant = await prepareTranscriptReadAuthority({
        purpose: "conversation-differences",
        personal: {
          originalParticipant,
          assertCurrent: composeSessionSourceAssertion([
            params.assertCurrent,
            targetFacts.assertCurrent,
          ]),
          target: branch,
          targetAudience: params.destinationAudience,
          contribution: receipt,
          rootEvidence: params.rootEvidence,
        },
        getRuntimeConfig: params.getRuntimeConfig,
        sources: [receipt.source],
      });
    } catch {
      // A hidden, removed or now-unreadable source does not become a discovery result.
      params.assertCurrent();
      targetFacts.assertCurrent();
      params.signal?.throwIfAborted();
      params.sourceCache?.invalidateContribution(contributionId);
      return undefined;
    }
    const read: (typeof reads)[number] = { grant };
    reads.push(read);
    grant.assertCurrent();
    const source = grant.sources[0];
    if (
      !source ||
      source.agentId !== branch.agentId ||
      source.canonicalKey !== receipt.source.sessionKey ||
      source.sessionId !== receipt.source.sessionId ||
      source.lifecycleRevision !== receipt.source.lifecycleRevision ||
      source.storePath !== branch.storePath ||
      source.storePath !== receipt.through.storePath
    ) {
      params.sourceCache?.invalidateContribution(contributionId);
      drop(read);
      return undefined;
    }
    read.facts = await prepareConversationKnowledgeBranchFacts({
      branch: {
        ...branch,
        sessionKey: source.canonicalKey,
        sessionId: source.sessionId,
        lifecycleRevision: receipt.source.lifecycleRevision,
      },
      getRuntimeConfig: params.getRuntimeConfig,
      contribution: receipt,
    });
    grant.assertCurrent();
    targetFacts.assertCurrent();
    if (read.facts.audienceIdentity !== targetFacts.audienceIdentity) {
      params.sourceCache?.invalidateContribution(contributionId);
      drop(read);
      return undefined;
    }
    const sourceAssertion = composeSessionSourceAssertion([
      params.assertCurrent,
      targetFacts.assertCurrent,
      grant.assertCurrent,
      read.facts.assertCurrent,
    ]);
    const projectionTarget = {
      agentId: source.agentId,
      sessionKey: source.canonicalKey,
      sessionId: source.sessionId,
      storePath: source.storePath,
    };
    const through = grant.contributionRange?.through ?? receipt.through;
    const from = grant.contributionRange?.from;
    return { read, grant, sourceAssertion, projectionTarget, through, from, facts: read.facts };
  };
  type PreparedSource = NonNullable<Awaited<ReturnType<typeof prepareSource>>>;
  const preparedSources = new Map<string, PreparedSource>();
  // At most the current and next range are hydrated; future grants are not an eager all-source scan.
  const preparedProjections = new Map<string, SessionTranscriptModelContextRangeResult>();
  const acceptProjection = (result: SessionTranscriptModelContextRangeResult) => {
    if (result.ok) {
      return result.context;
    }
    if (result.reason === "source-range-over-capacity") {
      throw new RangeError("Conversation source range exceeds native context capacity");
    }
    throw new SessionTranscriptReadFenceError("Conversation source range is no longer verified");
  };
  return {
    async take(receipt: ConversationKnowledgeReference) {
      const contributionId = conversationKnowledgeContributionId(receipt);
      const cachedSource = preparedSources.get(contributionId);
      const source =
        cachedSource && reads.includes(cachedSource.read)
          ? cachedSource
          : await prepareSource(receipt);
      preparedSources.delete(contributionId);
      const projection = preparedProjections.get(contributionId);
      preparedProjections.delete(contributionId);
      return { source, projection };
    },
    async load(
      preparedSource: PreparedSource,
      preparedProjection: SessionTranscriptModelContextRangeResult | undefined,
      receipt: ConversationKnowledgeReference,
      nextReceipt: ConversationKnowledgeReference | undefined,
      canReadAhead: boolean,
    ) {
      const { grant, sourceAssertion, projectionTarget, through, from } = preparedSource;
      const loadSingleProjection = () =>
        readSessionTranscriptModelContextAsync(
          projectionTarget,
          (context) => {
            grant.assertCurrent();
            return context;
          },
          undefined,
          params.signal,
          through,
          {
            ...CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
            ...(grant.contributionRange ? { from: grant.contributionRange.from } : {}),
          },
        );
      const loadProjection = async () => {
        if (preparedProjection) {
          return acceptProjection(preparedProjection);
        }
        const nextId = nextReceipt && conversationKnowledgeContributionId(nextReceipt);
        if (
          !params.sourceCache ||
          !nextReceipt ||
          !nextId ||
          params.hasRetainedContribution(nextId) ||
          !canReadAhead ||
          nextReceipt.source.sessionId !== receipt.source.sessionId ||
          nextReceipt.source.sessionKey !== receipt.source.sessionKey ||
          nextReceipt.through.generation !== receipt.through.generation
        ) {
          return loadSingleProjection();
        }
        const next = await prepareSource(nextReceipt);
        if (!next) {
          return loadSingleProjection();
        }
        preparedSources.set(nextId, next);
        const results = await readSessionTranscriptModelContextsAsync(
          projectionTarget,
          [
            {
              through,
              limits: { ...CONVERSATION_KNOWLEDGE_SOURCE_LIMITS, ...(from ? { from } : {}) },
            },
            {
              through: next.through,
              limits: {
                ...CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
                ...(next.from ? { from: next.from } : {}),
              },
            },
          ],
          (contexts) => {
            sourceAssertion();
            next.sourceAssertion();
            return contexts;
          },
          params.signal,
        );
        preparedProjections.set(nextId, results[1]!);
        return acceptProjection(results[0]!);
      };

      return loadProjection();
    },
  };
}
