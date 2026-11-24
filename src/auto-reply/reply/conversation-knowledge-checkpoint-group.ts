import { setImmediate } from "node:timers/promises";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import type { PreparedConversationBranchCreation } from "../../config/sessions/conversation-branch-creation.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import { selectConversationKnowledgeReceipts } from "../../config/sessions/conversation-knowledge-selection.js";
import {
  prepareNativeKnowledgeRootContributionGroup,
  prepareConversationKnowledgeRootSubset,
  type ConversationKnowledgeBranch,
  type NativeKnowledgeRootEvidence,
  type PreparedKnowledgeRootCandidates,
} from "../../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SessionMutationAuthorizationChangedError } from "../../gateway/session-mutation-authorization-error.js";
import { SessionMutationFactsUnavailableError } from "../../gateway/session-sharing-incognito.js";
import { validatePersonalContributionGroupAnchors } from "../../gateway/session-transcript-personal-contribution-anchors.js";
import {
  preparePersonalConversationContributionGroup,
  preparePersonalConversationRead,
  type PreparedPersonalConversationContributionGroup,
} from "../../gateway/session-transcript-personal-read.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import {
  validateCheckpointCachedPackets,
  type InvalidCheckpointCachedPacket,
} from "./conversation-knowledge-checkpoint-range.js";
import type {
  ConversationKnowledgeSourceCache,
  PreparedConversationKnowledgePacket,
} from "./conversation-knowledge-source-cache.js";
import {
  publishPreparedConversationKnowledgeRoot,
  type ConversationKnowledgeHeldSource,
} from "./conversation-knowledge-source-reader.js";

/** Candidate aliases still require the native personal read owner before disclosure. */
export function selectCheckpointSourceReferences(params: {
  events: Parameters<typeof selectConversationKnowledgeReceipts>[0];
  branch: ConversationKnowledgeBranch;
  participant: SessionParticipantIdentity;
  audienceIdentity: string;
}) {
  const references = selectConversationKnowledgeReceipts(
    params.events,
    params.branch.root.sessionId,
    params.branch.root.sessionKey,
  ).filter(
    (reference) =>
      !reference.retirement &&
      reference.source.agentId === params.branch.agentId &&
      (conversationKnowledgeParticipantIdentity(reference.privateAudience?.participant) ===
        params.audienceIdentity ||
        (params.participant.type === "profile" &&
          reference.privateAudience?.participant.type === "remote")),
  );
  return {
    references,
    currentOwn: (reference: ConversationKnowledgeReference) =>
      reference.source.sessionKey === params.branch.sessionKey &&
      reference.source.sessionId === params.branch.sessionId &&
      reference.source.lifecycleRevision === params.branch.lifecycleRevision,
  };
}

/** Current own history uses admitted custody and exact anchors, never a self grant. */
export async function prepareCheckpointOwnGroup(params: {
  branch: ConversationKnowledgeBranch;
  evidence: NativeKnowledgeRootEvidence | undefined;
  contributions: readonly ConversationKnowledgeReference[];
  readSource(): Promise<CapturedSessionEntryReadSource>;
  assertCurrent: SessionSourceAssertion;
  workCheck: () => void;
  signal: AbortSignal;
}) {
  // Current own history uses its admitted reader instead of a foreign group grant.
  prepareNativeKnowledgeRootContributionGroup(params.evidence, params.branch, params.contributions);
  const readSource = await params.readSource();
  const source = {
    agentId: params.branch.agentId,
    canonicalKey: params.branch.sessionKey,
    sessionId: params.branch.sessionId,
    lifecycleRevision: params.branch.lifecycleRevision,
    readSource,
  };
  const version = await validatePersonalContributionGroupAnchors({
    contributions: params.contributions,
    source,
    assertCurrent: params.workCheck,
    signal: params.signal,
  });
  return {
    source,
    assertCurrent: params.assertCurrent,
    selectContribution: (reference: ConversationKnowledgeReference) => ({
      through: reference.readRange?.through ?? reference.through,
      from: reference.readRange?.admission ?? reference.privateAudience?.admission,
      version,
    }),
    finish() {},
  };
}

/** Capacity changes cache reuse only; native uncached preparation remains available. */
export function prepareCheckpointGroupCache(params: {
  cache?: ConversationKnowledgeSourceCache;
  evidence?: NativeKnowledgeRootEvidence;
  branch: ConversationKnowledgeBranch;
  references: readonly ConversationKnowledgeReference[];
  audienceIdentity: string;
  workCheck: () => void;
}) {
  params.workCheck();
  if (!params.references.length || !params.cache || !params.evidence) {
    return undefined;
  }
  try {
    publishPreparedConversationKnowledgeRoot({
      cache: params.cache,
      evidence: params.evidence,
      branch: params.branch,
      receipts: params.references,
      audienceIdentity: params.audienceIdentity,
    });
    params.workCheck();
    return params.cache.preparedRoot;
  } catch (error) {
    params.workCheck();
    if (!(error instanceof RangeError)) {
      throw error;
    }
    return undefined;
  }
}

/** Cache only native admission metadata. Every use supplies current evidence and a fresh live grant. */
export async function prepareCheckpointGroupRead(params: {
  branch: ConversationKnowledgeBranch;
  participant: SessionParticipantIdentity;
  audience: ConversationPrivateAudience;
  contributions: readonly ConversationKnowledgeReference[];
  evidence?: NativeKnowledgeRootEvidence;
  cache?: ConversationKnowledgeSourceCache;
  manifest?: PreparedKnowledgeRootCandidates;
  targetCreation?: PreparedConversationBranchCreation;
  signal: AbortSignal;
  assertCurrent: SessionSourceAssertion;
  workCheck: () => void;
  getRuntimeConfig: () => OpenClawConfig;
  groups: PreparedPersonalConversationContributionGroup[];
  reads: ConversationKnowledgeHeldSource[];
  drop: (read: ConversationKnowledgeHeldSource) => void;
}) {
  const first = params.contributions[0]!;
  const sourceTarget = { ...first.source, storePath: first.through.storePath };
  const { cache } = params;
  let { manifest } = params;
  const existing = manifest && cache?.preparedContributionGroup(sourceTarget, manifest);
  let cached =
    existing &&
    params.contributions.every(
      (reference) =>
        cache?.preparedContributionGroup(
          sourceTarget,
          manifest!,
          conversationKnowledgeContributionId(reference),
        ) === existing,
    )
      ? existing
      : undefined;
  let expectedGroup = existing;
  const retainedManifest =
    cached && cache?.preparedContributionGroupManifest(sourceTarget, manifest!);
  let subset: ReturnType<typeof prepareConversationKnowledgeRootSubset> | undefined;
  try {
    subset = manifest
      ? prepareConversationKnowledgeRootSubset({
          evidence: params.evidence,
          branch: params.branch,
          ...(retainedManifest
            ? { manifest: retainedManifest }
            : {
                references: params.contributions,
                maxBytes: cache!.maxPreparedRootBytes,
              }),
        })
      : undefined;
  } catch (error) {
    params.workCheck();
    if (!(error instanceof RangeError)) {
      throw error;
    }
    // A bounded cache can decline this donor without declining its native read.
    manifest = undefined;
    cached = undefined;
  }
  const personal = {
    originalParticipant: params.participant,
    assertCurrent: params.assertCurrent,
    target: params.branch,
    targetAudience: params.audience,
    targetCreation: params.targetCreation,
    rootEvidence: subset?.evidence ?? params.evidence,
  };
  const common = {
    purpose: "conversation-differences" as const,
    signal: params.signal,
    getRuntimeConfig: params.getRuntimeConfig,
    sources: [first.source],
  };
  const currentSelection = () =>
    !manifest ||
    (cache?.preparedRoot === manifest &&
      cache.preparedContributionGroup(sourceTarget, manifest) === expectedGroup);
  let grant: Awaited<ReturnType<typeof preparePersonalConversationRead>> | undefined;
  let provisional: PreparedPersonalConversationContributionGroup | undefined;
  let transferred = false;
  let read: ConversationKnowledgeHeldSource | undefined;
  const finish = () => {
    if (provisional && !transferred) {
      provisional.release();
      const index = params.groups.indexOf(provisional);
      if (index >= 0) {
        params.groups.splice(index, 1);
      }
      provisional = undefined;
    }
  };
  try {
    if (cached) {
      try {
        grant = await preparePersonalConversationRead({
          ...common,
          personal: { ...personal, contributionGroup: cached },
        });
      } catch (error) {
        params.workCheck();
        if (
          !(error instanceof SessionTranscriptReadFenceError) &&
          !(error instanceof SessionMutationAuthorizationChangedError) &&
          !(error instanceof SessionMutationFactsUnavailableError)
        ) {
          throw error;
        }
        if (!currentSelection()) {
          throw new SessionTranscriptReadFenceError(
            "Checkpoint donor selection changed during renewal",
          );
        }
        cache!.invalidateAdmission(sourceTarget);
        expectedGroup = undefined;
      }
    }
    if (!grant) {
      provisional = await preparePersonalConversationContributionGroup({
        ...common,
        personal: {
          ...personal,
          contributions: params.contributions,
          ...(expectedGroup ? { previousGroup: expectedGroup } : {}),
        },
      });
      params.groups.push(provisional);
      grant = await preparePersonalConversationRead({
        ...common,
        personal: { ...personal, contributionGroup: provisional },
      });
    }
    read = { grant };
    params.reads.push(read);
    params.workCheck();
    if (!currentSelection()) {
      throw new SessionTranscriptReadFenceError(
        "Checkpoint donor selection changed before publication",
      );
    }
    if (provisional && manifest && subset) {
      // retainContributionGroup owns release even when the bounded cache refuses it.
      const selected = provisional;
      transferred = true;
      const index = params.groups.indexOf(selected);
      if (index >= 0) {
        params.groups.splice(index, 1);
      }
      cache!.retainContributionGroup(
        params.contributions.map(conversationKnowledgeContributionId),
        sourceTarget,
        selected,
        manifest,
        subset.manifest,
      );
    }
    const currentGrant = grant;
    return {
      source: currentGrant.sources[0],
      assertCurrent: currentGrant.assertCurrent,
      selectContribution: (reference: ConversationKnowledgeReference) =>
        currentGrant.selectContribution(reference),
      finish,
    };
  } catch (error) {
    if (read) {
      params.drop(read);
    }
    finish();
    throw error;
  }
}

type SelectedCheckpointGroup =
  | Awaited<ReturnType<typeof prepareCheckpointOwnGroup>>
  | Awaited<ReturnType<typeof prepareCheckpointGroupRead>>;

export async function validateCheckpointGroupRanges(params: {
  selectedGroup: SelectedCheckpointGroup;
  contributions: readonly ConversationKnowledgeReference[];
  cachedPackets?: ReadonlyMap<string, PreparedConversationKnowledgePacket>;
  invalidCached?: InvalidCheckpointCachedPacket;
  workCheck(): void;
  signal: AbortSignal;
}) {
  const { selectedGroup, contributions, cachedPackets, invalidCached, workCheck, signal } = params;
  const { source, assertCurrent: assertSource } = selectedGroup;
  if (!source?.lifecycleRevision) {
    throw new SessionTranscriptReadFenceError("Checkpoint grouped source lifecycle is unavailable");
  }
  const selectedRanges = [];
  for (const [index, reference] of contributions.entries()) {
    if (index > 0 && index % 8 === 0) {
      await setImmediate(undefined, { signal });
      workCheck();
    }
    const range = selectedGroup.selectContribution(reference);
    if (!range?.version) {
      throw new SessionTranscriptReadFenceError("Checkpoint grouped source range is unavailable");
    }
    selectedRanges.push({
      reference,
      range: { ...range, version: range.version },
      packet: cachedPackets?.get(conversationKnowledgeContributionId(reference)),
    });
  }
  if (
    !(await validateCheckpointCachedPackets({
      selected: selectedRanges,
      target: {
        agentId: source.agentId,
        sessionKey: source.canonicalKey,
        sessionId: source.sessionId,
        storePath: source.readSource.path,
      },
      signal,
      check: () => {
        workCheck();
        assertSource();
      },
      invalidCached,
    }))
  ) {
    throw new SessionTranscriptReadFenceError("Checkpoint cached source range or prefix changed");
  }

  return { source, selectedRanges, sourceLifecycleRevision: source.lifecycleRevision };
}

export function createCheckpointForeignGroupReads(
  params: Omit<Parameters<typeof prepareCheckpointGroupRead>[0], "contributions"> & {
    workSignal: AbortSignal;
  },
) {
  return {
    read: (contributions: readonly ConversationKnowledgeReference[]) =>
      prepareCheckpointGroupRead({ ...params, contributions }),
    async repair(
      contributions: readonly ConversationKnowledgeReference[],
      changed: ReadonlySet<string>,
      cachedPackets: ReadonlyMap<string, PreparedConversationKnowledgePacket> | undefined,
      invalidCached: InvalidCheckpointCachedPacket,
    ) {
      const neighbors = contributions.filter((reference) => {
        const from = reference.readRange?.admission ?? reference.privateAudience?.admission;
        const through = reference.readRange?.through ?? reference.through;
        return (
          cachedPackets?.has(conversationKnowledgeContributionId(reference)) &&
          !changed.has(through.entryId) &&
          (!from || !changed.has(from.entryId))
        );
      });
      if (!neighbors.length) {
        return;
      }
      // Fresh custody, no retained proofs or partial publication from this probe.
      const readCount = params.reads.length;
      const group = await prepareCheckpointGroupRead({
        ...params,
        contributions: neighbors,
        cache: undefined,
        manifest: undefined,
      });
      try {
        await validateCheckpointGroupRanges({
          selectedGroup: group,
          contributions: neighbors,
          cachedPackets,
          invalidCached,
          workCheck: params.workCheck,
          signal: params.workSignal,
        });
      } finally {
        try {
          for (const borrowed of params.reads.slice(readCount).toReversed()) {
            params.drop(borrowed);
          }
        } finally {
          group.finish();
        }
      }
    },
  };
}
