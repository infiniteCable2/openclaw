import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-packets.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import { SessionMutationAuthorizationChangedError } from "../../gateway/session-mutation-authorization-error.js";
import { SessionMutationFactsUnavailableError } from "../../gateway/session-sharing-incognito.js";
import type { PreparedPersonalConversationContributionGroup } from "../../gateway/session-transcript-personal-read.js";
import { prepareTranscriptReadAuthority } from "../../gateway/session-transcript-read-authority.js";
import type {
  ConversationKnowledgeSourceReaderParams,
  ConversationKnowledgeHeldSource,
} from "./conversation-knowledge-source-reader.js";

/** Native source custody shared by selected ranges; callers retain each read until its COMMIT. */
export function createConversationKnowledgeSourceCustody(
  params: ConversationKnowledgeSourceReaderParams,
) {
  const { branch, originalParticipant, targetFacts, reads, drop } = params;
  type Grant = ConversationKnowledgeHeldSource["grant"];
  type GroupRead = {
    grant: Grant;
    sourceAssertion: SessionSourceAssertion;
    leases: number;
    closed: boolean;
    close: () => void;
  };
  const groups = new Map<PreparedPersonalConversationContributionGroup, GroupRead>();
  const leaseGroup = async (
    group: PreparedPersonalConversationContributionGroup,
    acquire: () => Promise<Grant>,
  ) => {
    let shared = groups.get(group);
    if (shared && shared.leases === 0) {
      // A failed final release retains custody for cleanup; never reuse it as
      // a fresh grant or silently forget an unfinished native release.
      shared.close();
      shared = undefined;
    }
    if (!shared) {
      const grant = await acquire();
      const entry: GroupRead = {
        grant,
        // The native group grant already retains the original recipient
        // assertion. Keep its identity through packet and range custody so the
        // atomic batch prepares this complete authority once, not per original.
        sourceAssertion: grant.assertCurrent,
        leases: 0,
        closed: false,
        close: () => {
          if (entry.leases || entry.closed) {
            return;
          }
          try {
            grant.release();
          } catch (error) {
            params.sourceCache?.retainCleanup(entry.close);
            throw error;
          }
          entry.closed = true;
          if (groups.get(group) === entry) {
            groups.delete(group);
          }
          params.sourceCache?.forgetCleanup(entry.close);
        },
      };
      shared = entry;
      groups.set(group, shared);
    }
    const held = shared;
    held.leases++;
    let released = false;
    return {
      sourceAssertion: held.sourceAssertion,
      grant: {
        ...held.grant,
        assertCurrent: () => {
          if (released) {
            throw new SessionTranscriptReadFenceError("Selected contribution read was released");
          }
          held.grant.assertCurrent();
        },
        release: () => {
          if (!released) {
            released = true;
            held.leases--;
          }
          held.close();
        },
      },
    };
  };
  const prepareSource = async (receipt: ConversationKnowledgeReference) => {
    const contributionId = conversationKnowledgeContributionId(receipt);
    const sourceTarget = { ...receipt.source, storePath: receipt.through.storePath };
    const group =
      params.readyOnly && params.retainInHistory && params.preparedManifest
        ? params.sourceCache?.preparedContributionGroup(
            sourceTarget,
            params.preparedManifest,
            contributionId,
          )
        : undefined;
    const preparedAdmission = params.sourceCache?.preparedAdmission(sourceTarget);
    if (params.readyOnly && !preparedAdmission && !group) {
      return undefined;
    }
    let grant: ConversationKnowledgeHeldSource["grant"];
    let groupedSourceAssertion: SessionSourceAssertion | undefined;
    let read: ConversationKnowledgeHeldSource | undefined;
    try {
      const request = {
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
      } as const;
      try {
        if (group) {
          const selected = await leaseGroup(group, () =>
            prepareTranscriptReadAuthority({
              ...request,
              personal: {
                originalParticipant,
                assertCurrent: request.personal.assertCurrent,
                target: branch,
                targetAudience: params.destinationAudience,
                rootEvidence: params.rootEvidence,
                contributionGroup: group,
              },
            }),
          );
          grant = selected.grant;
          groupedSourceAssertion = selected.sourceAssertion;
        } else {
          grant = await prepareTranscriptReadAuthority({ ...request, preparedAdmission });
        }
      } catch (error) {
        params.sourceCache?.invalidateAdmission(sourceTarget);
        // Only background preparation may reacquire invalid native custody.
        // A live boundary consumes ready work and never waits for discovery.
        if (!preparedAdmission || params.readyOnly) {
          throw error;
        }
        params.assertCurrent();
        targetFacts.assertCurrent();
        params.signal?.throwIfAborted();
        grant = await prepareTranscriptReadAuthority(request);
      }
      read = { grant };
      reads.push(read);
      grant.assertCurrent();
      const source = grant.sources[0];
      const admitted =
        source && (group || source.lifecycleRevision !== receipt.source.lifecycleRevision)
          ? grant.selectContribution(receipt)
          : undefined;
      if (
        !source ||
        source.agentId !== branch.agentId ||
        source.canonicalKey !== receipt.source.sessionKey ||
        source.sessionId !== receipt.source.sessionId ||
        (group && !admitted) ||
        (source.lifecycleRevision !== receipt.source.lifecycleRevision &&
          (!admitted ||
            admitted.originalLifecycleRevision !== receipt.source.lifecycleRevision ||
            admitted.currentLifecycleRevision !== source.lifecycleRevision)) ||
        source.storePath !== branch.storePath ||
        source.storePath !== receipt.through.storePath ||
        grant.audienceIdentity !== targetFacts.audienceIdentity
      ) {
        params.sourceCache?.invalidateContribution(contributionId);
        drop(read);
        return undefined;
      }
      targetFacts.assertCurrent();
      const sourceAssertion =
        groupedSourceAssertion ??
        composeSessionSourceAssertion([
          params.assertCurrent,
          targetFacts.assertCurrent,
          grant.assertCurrent,
        ]);
      const projectionTarget = {
        agentId: source.agentId,
        sessionKey: source.canonicalKey,
        sessionId: source.sessionId,
        storePath: source.storePath,
      };
      const through = admitted?.through ?? grant.contributionRange?.through ?? receipt.through;
      const from = admitted?.from ?? grant.contributionRange?.from;
      return {
        read,
        grant,
        sourceAssertion,
        projectionTarget,
        through,
        from,
        facts: grant,
        historicalCustody: admitted,
        grouped: group !== undefined,
      };
    } catch (error) {
      if (read) {
        drop(read);
      }
      // A hidden, removed or now-unreadable source does not become a discovery result.
      params.assertCurrent();
      targetFacts.assertCurrent();
      params.signal?.throwIfAborted();
      params.sourceCache?.invalidateContribution(contributionId);
      if (
        !(error instanceof SessionMutationAuthorizationChangedError) &&
        !(error instanceof SessionTranscriptReadFenceError) &&
        !(
          params.readyOnly &&
          preparedAdmission &&
          error instanceof SessionMutationFactsUnavailableError
        )
      ) {
        // Unavailable facts and worker failures must reach the background owner's
        // bounded retry instead of silently settling this source as prepared.
        throw error;
      }
      return undefined;
    }
  };
  return prepareSource;
}
