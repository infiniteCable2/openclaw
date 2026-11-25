import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { redactIdentifier, sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { PreparedConversationBranchCreation } from "../../config/sessions/conversation-branch-creation.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
  conversationKnowledgePacketId,
} from "../../config/sessions/conversation-knowledge-packets.js";
import {
  prepareConversationKnowledgeRootSubset,
  readConversationKnowledgeBranch,
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
import { readSessionTranscriptModelContextAsync } from "../../config/sessions/session-transcript-context-read.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { preparePersonalConversationRead } from "../../gateway/session-transcript-personal-read.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import {
  prepareConversationKnowledgeBranchFacts,
  unavailableConversationKnowledge,
} from "./conversation-knowledge-authority.js";
import { readConversationKnowledgeSourceBatch } from "./conversation-knowledge-source-batch.js";
import type {
  ConversationKnowledgeSourceCache,
  ConversationKnowledgeSourceSelection,
  PreparedConversationKnowledgePacket,
} from "./conversation-knowledge-source-cache.js";
import { createConversationKnowledgeSourceCustody } from "./conversation-knowledge-source-custody.js";
import { logConversationKnowledgePreparedRanges } from "./conversation-knowledge-status.js";

export { readConversationKnowledgeInputs } from "./conversation-knowledge-inputs.js";

const log = createSubsystemLogger("conversation-knowledge");

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

/** Retain a donor's prepared subset while its exact originals remain in the native root. */
export function prepareConversationKnowledgeSourceSelection(params: {
  evidence: NativeKnowledgeRootEvidence | undefined;
  branch: ConversationKnowledgeBranch;
  receipts: readonly ConversationKnowledgeReference[];
  audienceIdentity: string | undefined;
  maxBytes: number;
  /** Private reuse hint from the cache's exact ordered receipt key. */
  manifest?: PreparedKnowledgeRootCandidates;
}): ConversationKnowledgeSourceSelection & { manifest: PreparedKnowledgeRootCandidates } {
  if (!params.audienceIdentity) {
    throw new Error("Prepared source selection requires a confirmed private audience");
  }
  let scope: ReturnType<typeof prepareConversationKnowledgeRootSubset> | undefined;
  if (params.manifest) {
    try {
      scope = prepareConversationKnowledgeRootSubset({
        evidence: params.evidence,
        branch: params.branch,
        manifest: params.manifest,
      });
    } catch {
      // Only disposable provenance is reused. Changed physical/recipient scope
      // needs a fresh selection; its native owner still refuses revoked evidence.
    }
  }
  scope ??= prepareConversationKnowledgeRootSubset({
    evidence: params.evidence,
    branch: params.branch,
    references: params.receipts,
    maxBytes: params.maxBytes,
  });
  const current = scope;
  return {
    manifest: current.manifest,
    scopeKey: JSON.stringify([current.scopeKey, params.audienceIdentity]),
    contains(manifest) {
      try {
        prepareConversationKnowledgeRootSubset({
          evidence: current.evidence,
          branch: params.branch,
          manifest,
        });
        return true;
      } catch {
        // This only retains disposable preparation; unavailable or changed
        // provenance still discards it. Disclosure obtains its fresh grant.
        return false;
      }
    },
  };
}

/** Publish immutable provenance while the original background read is still current. */
export function publishPreparedConversationKnowledgeRoot(params: {
  evidence: NativeKnowledgeRootEvidence | undefined;
  receipts: readonly ConversationKnowledgeReference[];
  cache: ConversationKnowledgeSourceCache;
  branch: ConversationKnowledgeBranch;
  audienceIdentity: string | undefined;
}) {
  // Provenance is byte-bounded by the cache, not by the SQL query batch size.
  // Packet consumption never changes which original ranges a native group
  // selected. Keep canonical provenance whole; the existing byte cap still applies.
  const receipts = params.receipts;
  return params.cache.prepareRootSelection(sha256Hex(JSON.stringify(receipts)), (manifest) => {
    const sourceSelection = prepareConversationKnowledgeSourceSelection({
      ...params,
      manifest,
      maxBytes: params.cache.maxPreparedRootBytes,
    });
    if (log.isEnabled("debug")) {
      log.debug("Related-history prepared selection", {
        recipientHash: redactIdentifier(params.branch.sessionId),
        keyHit: manifest !== undefined,
        manifestReused: sourceSelection.manifest === manifest,
        manifestBytes: sourceSelection.manifest.byteLength,
      });
    }
    return { manifest: sourceSelection.manifest, sourceSelection };
  });
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
  targetCreation?: PreparedConversationBranchCreation;
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

  const preparedRanges: Parameters<
    typeof logConversationKnowledgePreparedRanges
  >[0]["ranges"][number][] = [];
  // Prefetch is confined to the current bounded window of consecutive ranges.
  const prepared = new Map<
    string,
    { source: PreparedSource; projection: SessionTranscriptModelContextRangeResult }
  >();
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
    reportPreparation() {
      logConversationKnowledgePreparedRanges({
        recipient: branch.sessionId,
        ranges: preparedRanges,
      });
      preparedRanges.length = 0;
    },
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
          preparedRanges.push({
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
      const prefetched = prepared.get(contributionId);
      prepared.delete(contributionId);
      if (prefetched && reads.includes(prefetched.source.read)) {
        return prefetched;
      }
      return { source: await prepareSource(receipt), projection: undefined };
    },
    async load(
      preparedSource: PreparedSource,
      preparedProjection: SessionTranscriptModelContextRangeResult | undefined,
      receipt: ConversationKnowledgeReference,
      nextReceipt:
        | ConversationKnowledgeReference
        | readonly ConversationKnowledgeReference[]
        | undefined,
      canReadAhead: boolean | "checkpoint",
    ) {
      const { grant, sourceAssertion, projectionTarget, through } = preparedSource;
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
      if (preparedProjection) {
        sourceAssertion();
        return acceptProjection(preparedProjection);
      }
      if (!canReadAhead || (!params.sourceCache && canReadAhead !== "checkpoint") || !nextReceipt) {
        return loadSingleProjection();
      }
      const successors = "source" in nextReceipt ? [nextReceipt] : nextReceipt;
      const batch = await readConversationKnowledgeSourceBatch({
        current: preparedSource,
        receipt,
        successors,
        prepareNext: async (next) => {
          const id = conversationKnowledgeContributionId(next);
          return prepared.has(id) || params.hasRetainedContribution(id)
            ? undefined
            : prepareSource(next);
        },
        drop: params.drop,
        assertCurrent: () => {
          params.assertCurrent();
          targetFacts.assertCurrent();
          sourceAssertion();
        },
        signal: params.signal,
      });
      if (!batch) {
        return loadSingleProjection();
      }
      for (const next of batch.next) {
        prepared.set(conversationKnowledgeContributionId(next.receipt), next);
      }
      return batch.context;
    },
  };
}
