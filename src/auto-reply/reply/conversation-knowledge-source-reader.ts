import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { PreparedConversationKnowledgeCheckpointCoverage } from "../../config/sessions/conversation-knowledge-checkpoint.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
  conversationKnowledgePacketId,
  readConversationKnowledgePacketProgress,
} from "../../config/sessions/conversation-knowledge-packets.js";
import {
  selectConversationKnowledgeObserved,
  selectConversationKnowledgeReceipts,
} from "../../config/sessions/conversation-knowledge-selection.js";
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
import type { preparePersonalConversationRead } from "../../gateway/session-transcript-personal-read.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import {
  prepareConversationKnowledgeBranchFacts,
  unavailableConversationKnowledge,
} from "./conversation-knowledge-authority.js";
import type {
  ConversationKnowledgeSourceCache,
  PreparedConversationKnowledgePacket,
} from "./conversation-knowledge-source-cache.js";
import { createConversationKnowledgeSourceCustody } from "./conversation-knowledge-source-custody.js";
import { logConversationKnowledgeTransfer } from "./conversation-knowledge-status.js";

export type ConversationKnowledgeHeldSource = {
  grant: Awaited<ReturnType<typeof preparePersonalConversationRead>>;
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
    getRuntimeConfig: () => params.getRuntimeConfig(),
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
  sourceCache?: ConversationKnowledgeSourceCache;
}) {
  if (params.readyOnly && !params.manifest) {
    return undefined;
  }
  const check = () => {
    params.assertCurrent();
    params.signal?.throwIfAborted();
  };
  const cache = params.preparationOnly ? params.sourceCache : undefined;
  const epoch = cache?.consumptionRevision ?? -1;
  const readVersion = async (target: ConversationKnowledgeBranch) => {
    check();
    const { prepareSessionTranscriptHydration } =
      await import("../../config/sessions/session-transcript-hydration.js");
    check();
    const facts = await prepareSessionTranscriptHydration(
      { ...target, env: params.reader.database.env },
      undefined,
      params.signal,
    ).readMaintenance({ operation: "version" });
    check();
    if (!facts.version) {
      throw new Error("Conversation preparation input version is unavailable");
    }
    return facts.version;
  };
  const rebind = async (manifest: PreparedKnowledgeRootCandidates) => {
    try {
      return await readPreparedConversationKnowledgeRoot({ ...params, manifest });
    } catch (error) {
      params.signal?.throwIfAborted();
      cache?.clearPreparationInputs();
      params.sourceCache?.clearPreparedRoot(manifest);
      throw error;
    }
  };
  const readRoot = async () => {
    if (params.manifest) {
      return rebind(params.manifest);
    }
    if (!cache) {
      return readConversationKnowledgeRoot(params);
    }
    const target = { ...params.branch, ...params.branch.root };
    let version = await readVersion(target);
    const cached = cache.preparationRoot(version);
    if (cached) {
      const events = await rebind(cached);
      const current = await readVersion(target);
      if (isDeepStrictEqual(version, current)) {
        return events;
      }
      cache.preparationRoot(current);
      version = current;
    }
    const events = await readConversationKnowledgeRoot(params);
    const current = await readVersion(target);
    if (isDeepStrictEqual(version, current)) {
      try {
        cache.retainPreparationRoot(
          current,
          issuePreparedKnowledgeRootCandidates(
            events.evidence,
            selectConversationKnowledgeReceipts(events, ""),
            { maxBytes: cache.maxPreparedRootBytes },
          ),
          epoch,
        );
      } catch (error) {
        if (!(error instanceof RangeError)) {
          throw error;
        }
        // An oversized snapshot still serves this read; it is never retained.
      }
    }
    return events;
  };
  const events = await readRoot();
  check();
  const readDurableProgress = () =>
    readConversationKnowledgePacketProgress({
      ...params,
      async prepareCheckpointCoverage(checkpoints) {
        // An already admitted summary is recipient history. Resolve its immutable
        // coverage off-turn, without granting access to any original donor.
        const {
          readConversationKnowledgeCheckpointById,
          readConversationKnowledgeCheckpointCoverage,
        } = await import("../../config/sessions/conversation-knowledge-checkpoint-store.js");
        check();
        const prepared = new Map<string, PreparedConversationKnowledgeCheckpointCoverage>();
        for (const receipt of checkpoints) {
          check();
          let coverage = cache?.checkpointCoverage(receipt.checkpointId);
          if (!coverage) {
            const checkpoint = await readConversationKnowledgeCheckpointById({
              branch: params.branch,
              checkpointId: receipt.checkpointId,
              source: params.assertCurrent,
              signal: params.signal,
            });
            coverage = await readConversationKnowledgeCheckpointCoverage({
              reader: params.reader,
              branch: params.branch,
              checkpoint,
              source: params.assertCurrent,
              signal: params.signal,
            });
            check();
            cache?.retainCheckpointCoverage(receipt.checkpointId, coverage);
          }
          prepared.set(receipt.checkpointId, coverage);
        }
        return prepared;
      },
    });
  const readProgress = async () => {
    if (!cache) {
      return readDurableProgress();
    }
    let version = await readVersion(params.branch);
    const cached = cache.preparationProgress(version);
    if (cached) {
      // Even equal native versions cannot authorize a replacement physical store.
      await rebind(cached.manifest);
      const current = await readVersion(params.branch);
      if (isDeepStrictEqual(version, current)) {
        return cached.progress;
      }
      cache.preparationProgress(current);
      version = current;
    }
    const progress = await readDurableProgress();
    const current = await readVersion(params.branch);
    if (isDeepStrictEqual(version, current)) {
      try {
        cache.retainPreparationProgress(
          current,
          issuePreparedKnowledgeRootCandidates(events.evidence, [], {
            maxBytes: cache.maxPreparedRootBytes,
          }),
          progress,
          epoch,
        );
      } catch (error) {
        if (!(error instanceof RangeError)) {
          throw error;
        }
      }
    }
    return progress;
  };
  const retained =
    (params.retainInHistory && !params.readyOnly) || params.preparationOnly
      ? await readProgress()
      : undefined;
  check();
  return { events, retained, previous: selectConversationKnowledgeObserved(events, params.branch) };
}

/** Publish immutable provenance while the original background read is still current. */
export function publishPreparedConversationKnowledgeRoot(params: {
  evidence: NativeKnowledgeRootEvidence | undefined;
  receipts: readonly ConversationKnowledgeReference[];
  cache: ConversationKnowledgeSourceCache;
}) {
  // Provenance is byte-bounded by the cache, not by the SQL query batch size.
  const ready = new Set(params.cache.preparedContributionIds(Number.MAX_SAFE_INTEGER));
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
  const order = new Map([...byId.keys()].map((id, index) => [id, index]));
  const candidates = params.cache
    .preparedPackets(Number.MAX_SAFE_INTEGER)
    .filter((slot) => byId.has(slot.contributionId))
    .toSorted(
      (left, right) =>
        order.get(left.contributionId)! - order.get(right.contributionId)! ||
        left.offset - right.offset,
    )
    .slice(0, MAX_TRANSCRIPT_REPORT_BATCH_SIZE)
    .flatMap((slot) => {
      const receipt = byId.get(slot.contributionId);
      if (!receipt) {
        return [];
      }
      return [
        {
          ...slot,
          packetId: conversationKnowledgePacketId(slot.contributionId, slot.offset),
        },
      ];
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
export type ConversationKnowledgeSourceReaderParams = {
  branch: ConversationKnowledgeBranch;
  originalParticipant: SessionParticipantIdentity;
  destinationAudience?: ConversationPrivateAudience;
  rootEvidence?: NativeKnowledgeRootEvidence;
  targetFacts: Awaited<ReturnType<typeof prepareConversationKnowledgeBranchFacts>>;
  assertCurrent: SessionSourceAssertion;
  getRuntimeConfig: () => OpenClawConfig;
  signal?: AbortSignal;
  sourceCache?: ConversationKnowledgeSourceCache;
  readyOnly?: boolean;
  retainInHistory?: boolean;
  preparedManifest?: PreparedKnowledgeRootCandidates;
  hasRetainedContribution(contributionId: string): boolean;
  reads: ConversationKnowledgeHeldSource[];
  drop: (read: ConversationKnowledgeHeldSource) => void;
};

export function createConversationKnowledgeSourceReader(
  params: ConversationKnowledgeSourceReaderParams,
) {
  const { branch, targetFacts, reads } = params;
  const prepareSource = createConversationKnowledgeSourceCustody(params);
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
    async validate(source: PreparedSource, staged: PreparedConversationKnowledgePacket) {
      if (source.grouped && params.readyOnly && params.retainInHistory) {
        source.sourceAssertion();
        // Native group custody proves these exact anchors. The atomic writer
        // still validates every packet's original staged version before copying.
        return (
          isDeepStrictEqual(staged.through, source.through) &&
          isDeepStrictEqual(staged.from, source.from)
        );
      }
      const { validatePreparedConversationKnowledgeSource } =
        await import("./conversation-knowledge-source-validation.js");
      return validatePreparedConversationKnowledgeSource({
        ...source,
        staged,
        assertCurrent: composeSessionSourceAssertion([
          params.assertCurrent,
          targetFacts.assertCurrent,
        ]),
        signal: params.signal,
        readyOnly: params.readyOnly,
      });
    },
    async stage(input: {
      source: PreparedSource;
      receipt: ConversationKnowledgeReference;
      projection: SessionTranscriptModelContext;
      offset: number;
      expectedConsumptionRevision: number | undefined;
    }) {
      const { source, receipt } = input;
      const cache = params.sourceCache;
      const id = conversationKnowledgeContributionId(receipt);
      const target = { ...receipt.source, storePath: receipt.through.storePath };
      const previouslyUsable =
        cache?.firstPreparedOffset(id) !== undefined &&
        cache.preparedAdmission(target) !== undefined;
      const preparation = await stageConversationKnowledgeSource({
        ...input,
        audience: source.facts.audience,
        through: source.through,
        from: source.from,
        assertCurrent: source.sourceAssertion,
        signal: params.signal,
        cache,
      });
      params.assertCurrent();
      params.signal?.throwIfAborted();
      if (cache?.firstPreparedOffset(id) !== undefined) {
        if (
          !cache.retainAdmission(
            id,
            target,
            cache.preparedAdmission(target) ?? source.grant.prepareAdmission(),
          )
        ) {
          return "cache-full" as const;
        }
        if (!previouslyUsable) {
          logConversationKnowledgeTransfer({
            phase: "prepared",
            recipient: branch.sessionId,
            receipt,
            offset: input.offset,
            complete: preparation === "complete",
          });
        }
      }
      return preparation;
    },
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
