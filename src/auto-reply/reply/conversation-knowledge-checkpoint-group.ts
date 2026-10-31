import type { PreparedConversationBranchCreation } from "../../config/sessions/conversation-branch-creation.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import {
  prepareConversationKnowledgeRootSubset,
  type ConversationKnowledgeBranch,
  type NativeKnowledgeRootEvidence,
  type PreparedKnowledgeRootCandidates,
} from "../../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SessionMutationAuthorizationChangedError } from "../../gateway/session-mutation-authorization-error.js";
import { SessionMutationFactsUnavailableError } from "../../gateway/session-sharing-incognito.js";
import {
  preparePersonalConversationContributionGroup,
  preparePersonalConversationRead,
  type PreparedPersonalConversationContributionGroup,
} from "../../gateway/session-transcript-personal-read.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import type { ConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import {
  publishPreparedConversationKnowledgeRoot,
  type ConversationKnowledgeHeldSource,
} from "./conversation-knowledge-source-reader.js";

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
  if (!params.cache || !params.evidence) {
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
        personal: { ...personal, contributions: params.contributions },
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
    return { grant, finish };
  } catch (error) {
    if (read) {
      params.drop(read);
    }
    finish();
    throw error;
  }
}
