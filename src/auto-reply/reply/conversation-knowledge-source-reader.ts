import { setImmediate } from "node:timers/promises";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
  createConversationKnowledgePacketReport,
  readConversationKnowledgePacketProgress,
} from "../../config/sessions/conversation-knowledge-packets.js";
import { selectConversationKnowledgeObserved } from "../../config/sessions/conversation-knowledge-selection.js";
import {
  issuePreparedKnowledgeRootCandidates,
  readConversationKnowledgeRoot,
  readConversationKnowledgeBranch,
  readPreparedConversationKnowledgeRoot,
  type PreparedKnowledgeRootCandidates,
  type ConversationKnowledgeBranch,
  type NativeKnowledgeRootEvidence,
} from "../../config/sessions/conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
  projectConversationKnowledge,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import type { SessionTranscriptModelContextRangeResult } from "../../config/sessions/session-accessor.sqlite-model-context.js";
import { readSessionTranscriptReportReceipts } from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import {
  MAX_TRANSCRIPT_REPORT_BATCH_SIZE,
  type CustomMessageReportAppend,
} from "../../config/sessions/session-accessor.sqlite-transcript-reports.types.js";
import type { SessionTranscriptWriteScope } from "../../config/sessions/session-accessor.types.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SessionTranscriptModelContext } from "../../config/sessions/session-history-read.types.js";
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
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SessionMutationAuthorizationChangedError } from "../../gateway/session-mutation-authorization-error.js";
import { prepareTranscriptReadAuthority } from "../../gateway/session-transcript-read-authority.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import {
  prepareConversationKnowledgeBranchFacts,
  unavailableConversationKnowledge,
} from "./conversation-knowledge-authority.js";
import type { ConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";

export type ConversationKnowledgeHeldSource = {
  grant: Awaited<ReturnType<typeof prepareTranscriptReadAuthority>>;
  facts?: Awaited<ReturnType<typeof prepareConversationKnowledgeBranchFacts>>;
  origin?: string;
};

/** Confirm the actual private recipient before any cross-conversation source is selected. */
export async function prepareConversationKnowledgeTarget(params: {
  reader: SessionEntryCohortReader;
  sessionId: string;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  retainedSignal?: AbortSignal;
  destinationAudience?: ConversationPrivateAudience;
  expectedAudienceIdentity?: string;
  participantIdentity: string;
  getRuntimeConfig(): OpenClawConfig;
}) {
  const branch = await readConversationKnowledgeBranch(params);
  params.assertCurrent();
  params.signal?.throwIfAborted();
  if (!branch) {
    return undefined;
  }
  try {
    params.destinationAudience?.assertCurrent();
  } catch {
    return {
      kind: "unavailable" as const,
      unavailable: unavailableConversationKnowledge(
        params,
        "private-destination-audience-unconfirmed",
      ),
    };
  }
  const targetFacts = await prepareConversationKnowledgeBranchFacts({
    branch,
    getRuntimeConfig: params.getRuntimeConfig,
    destinationAudience: params.destinationAudience,
  });
  // A private source grant does not authorize disclosure to a room or shared device.
  if (
    targetFacts.audience !== "private-direct" ||
    !targetFacts.audienceIdentity ||
    targetFacts.audienceIdentity !== params.participantIdentity ||
    (params.expectedAudienceIdentity !== undefined &&
      targetFacts.audienceIdentity !== params.expectedAudienceIdentity)
  ) {
    targetFacts.release();
    return {
      kind: "unavailable" as const,
      unavailable: unavailableConversationKnowledge(
        params,
        "private-destination-audience-unconfirmed",
      ),
    };
  }
  return { kind: "ready" as const, branch, targetFacts };
}

/** Fill disposable segments from one authorized projection, bounded by the shared cache budget. */
export async function stageConversationKnowledgeSource(params: {
  receipt: ConversationKnowledgeReference;
  projection: SessionTranscriptModelContext;
  audience: Parameters<typeof projectConversationKnowledge>[3];
  offset: number;
  through: TranscriptEntryAnchor;
  from?: TranscriptEntryAnchor;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  cache?: ConversationKnowledgeSourceCache;
  expectedConsumptionRevision: number | undefined;
}): Promise<"complete" | "cache-full" | "recipient-advanced"> {
  let offset = params.offset;
  for (;;) {
    params.assertCurrent();
    params.signal?.throwIfAborted();
    if (params.cache && params.cache.consumptionRevision !== params.expectedConsumptionRevision) {
      return "recipient-advanced";
    }
    const part = projectConversationKnowledge(
      params.receipt,
      params.projection.events,
      undefined,
      params.audience,
      { offset },
    );
    if (!part || !params.projection.version || !params.cache) {
      break;
    }
    if (
      !params.cache.stage(conversationKnowledgeContributionId(params.receipt), offset, {
        part,
        version: params.projection.version,
        through: params.through,
        from: params.from,
      })
    ) {
      return "cache-full";
    }
    if (part.frontier || part.nextOffset === undefined || part.nextOffset <= offset) {
      break;
    }
    offset = part.nextOffset;
    await setImmediate(undefined, { signal: params.signal });
    params.signal?.throwIfAborted();
  }
  return "complete";
}

/** Only background/legacy readers enumerate history; live boundaries rebind bounded provenance. */
export async function readConversationKnowledgeInputs(params: {
  branch: ConversationKnowledgeBranch;
  reader: SessionEntryCohortReader;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  readyOnly?: boolean;
  preparationOnly?: boolean;
  retainInHistory: boolean;
  manifest?: PreparedKnowledgeRootCandidates;
}) {
  if (params.readyOnly && !params.manifest) {
    return undefined;
  }
  const events = params.manifest
    ? await readPreparedConversationKnowledgeRoot({ ...params, manifest: params.manifest })
    : await readConversationKnowledgeRoot(params);
  params.assertCurrent();
  params.signal?.throwIfAborted();
  const retained =
    (params.retainInHistory && !params.readyOnly) || params.preparationOnly
      ? await readConversationKnowledgePacketProgress(params)
      : undefined;
  return { events, retained, previous: selectConversationKnowledgeObserved(events, params.branch) };
}

/** Publish immutable provenance while the original background read is still current. */
export function publishPreparedConversationKnowledgeRoot(params: {
  evidence: NativeKnowledgeRootEvidence | undefined;
  receipts: readonly ConversationKnowledgeReference[];
  cache: ConversationKnowledgeSourceCache;
}) {
  const ready = new Set(params.cache.preparedContributionIds(MAX_TRANSCRIPT_REPORT_BATCH_SIZE));
  params.cache.setPreparedRoot(
    issuePreparedKnowledgeRootCandidates(
      params.evidence,
      params.receipts.filter((receipt) => ready.has(conversationKnowledgeContributionId(receipt))),
      { maxBytes: params.cache.maxPreparedRootBytes },
    ),
  );
}

/** An old cached packet is not permission to resurrect native compacted history. */
export async function observePreparedConversationKnowledgePackets(params: {
  branch: ConversationKnowledgeBranch;
  receipts: readonly ConversationKnowledgeReference[];
  cache: ConversationKnowledgeSourceCache;
  writeTarget: SessionTranscriptWriteScope;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
}) {
  const readyPacketIds = new Set<string>();
  const activeCarriers = new Map<string, CustomMessageReportAppend>();
  const contributions = new Set<string>();
  const byId = new Map(
    params.receipts.map((receipt) => [conversationKnowledgeContributionId(receipt), receipt]),
  );
  const candidates = params.cache
    .preparedPackets(MAX_TRANSCRIPT_REPORT_BATCH_SIZE)
    .flatMap((slot) => {
      const receipt = byId.get(slot.contributionId);
      if (!receipt) {
        return [];
      }
      const report = createConversationKnowledgePacketReport({
        branch: params.branch,
        receipt,
        text: "",
        offset: slot.offset,
        nextOffset: slot.offset,
        complete: false,
      });
      return [{ ...slot, packetId: report.details.packetId }];
    });
  if (!candidates.length) {
    return { readyPacketIds, activeCarriers, contributions };
  }
  const current = await readSessionTranscriptReportReceipts(
    params.writeTarget,
    candidates.map(({ packetId }) => ({
      customType: CONVERSATION_KNOWLEDGE_CONTEXT,
      receipt: { field: "packetId", value: packetId },
    })),
    { source: params.assertCurrent },
  );
  params.assertCurrent();
  params.signal?.throwIfAborted();
  if (!current.ok) {
    throw new Error("Conversation receipt observation was refused", { cause: current.error });
  }
  for (const candidate of candidates) {
    contributions.add(candidate.contributionId);
  }
  for (const observation of current.value) {
    readyPacketIds.add(observation.receipt.value);
    if (observation.status === "active-model") {
      activeCarriers.set(observation.receipt.value, observation.report);
    } else if (observation.status === "historical") {
      const slot = candidates.find((candidate) => candidate.packetId === observation.receipt.value);
      if (slot) {
        // Positive native receipt/window proof, never absence or a cached inference.
        params.cache.consume(slot.contributionId, slot.offset);
      }
    }
  }
  return { readyPacketIds, activeCarriers, contributions };
}

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
    } catch (error) {
      // A hidden, removed or now-unreadable source does not become a discovery result.
      params.assertCurrent();
      targetFacts.assertCurrent();
      params.signal?.throwIfAborted();
      params.sourceCache?.invalidateContribution(contributionId);
      if (
        !(error instanceof SessionMutationAuthorizationChangedError) &&
        !(error instanceof SessionTranscriptReadFenceError)
      ) {
        // Unavailable facts and worker failures must reach the background owner's
        // bounded retry instead of silently settling this source as prepared.
        throw error;
      }
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
