import { conversationKnowledgeHistoricalContributionIdentity } from "../../config/sessions/conversation-audience.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import { issuePersonalConversationContributionRange } from "../../config/sessions/conversation-knowledge-source-custody.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import type { PreparedInitialSessionContextSourceClaim } from "../../config/sessions/session-initial-context.js";
import {
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { PersonalConversationReadRefusedError } from "../../gateway/session-mutation-authorization-error.js";
import type { PreparedInitialFrameRange } from "./conversation-knowledge-checkpoint-frame-source.js";
import type { PreparedConversationKnowledgePacket } from "./conversation-knowledge-source-cache.js";

export type PreparedRootKnowledgeContribution = {
  contributionId: string;
  complete: true;
  text: string;
  reference: ConversationKnowledgeReference;
  packet: PreparedConversationKnowledgePacket;
};
export type PreparedRootKnowledgeRange = {
  through: ConversationKnowledgeReference["through"];
  from?: ConversationKnowledgeReference["through"];
  claim: PreparedInitialSessionContextSourceClaim;
};

/** Native read owners record exact range custody separately from disposable hydration. */
export function createCheckpointRangeRecorder(params: {
  branch: ConversationKnowledgeBranch;
  check: () => void;
  proofs: SessionSourceAssertion[];
}) {
  const versions = new Map<string, SessionSourceAssertion>();
  const nativeRanges = new Map<string, PreparedInitialFrameRange>();
  const record = (
    reference: ConversationKnowledgeReference,
    nativeSource: CapturedSessionEntryReadSource,
    version: PreparedConversationKnowledgePacket["version"],
    lifecycleRevision: string,
    nativeAuthority: SessionSourceAssertion,
    range?: {
      through: ConversationKnowledgeReference["through"];
      from?: ConversationKnowledgeReference["through"];
    },
    retainProof?: (source: SessionSourceAssertion) => void,
  ) => {
    const predicate = {
      source: nativeSource,
      sessionKey: reference.source.sessionKey,
      fields: ["sessionId", "lifecycleRevision"] as const,
      expected: { sessionId: reference.source.sessionId, lifecycleRevision },
      transcript: {
        sessionId: reference.source.sessionId,
        version,
        consistency: "prefix" as const,
      },
    };
    const proofKey = JSON.stringify([
      nativeSource,
      predicate.sessionKey,
      predicate.expected,
      version,
    ]);
    let retained = versions.get(proofKey);
    if (!retained || !params.proofs.includes(retained)) {
      const proof = Object.assign(() => params.check(), {
        prepareSessionSource: async (): Promise<PreparedSessionSourceAuthority> => ({
          assertCurrent: params.check,
          checks: [
            {
              predicate: { ...predicate, fields: [...predicate.fields] },
              refuse: (): never => {
                throw new Error("Checkpoint original source changed before publication");
              },
            },
          ],
        }),
      });
      params.proofs.push(proof);
      versions.set(proofKey, proof);
      retained = proof;
    }
    retainProof?.(retained);
    const claim = {
      reference,
      predicate: { ...predicate, fields: [...predicate.fields] },
      sessionId: reference.source.sessionId,
      version,
      through: range?.through ?? reference.readRange?.through ?? reference.through,
      from: range
        ? range.from
        : (reference.readRange?.admission ?? reference.privateAudience?.admission),
    } satisfies PreparedInitialSessionContextSourceClaim;
    const rangeProof = issuePersonalConversationContributionRange({
      reference,
      target: params.branch,
      source: composeSessionSourceAssertion([params.check, nativeAuthority]),
      range: {
        origin: reference.origin,
        originalLifecycleRevision: reference.source.lifecycleRevision,
        currentLifecycleRevision: lifecycleRevision,
        through: claim.through,
        from: claim.from,
        version,
      },
    });
    nativeRanges.set(conversationKnowledgeContributionId(reference), {
      claim,
      range: rangeProof,
    });
    return claim;
  };
  return { record, nativeRanges };
}

/** Own-history reads still prove the exact current private incarnation. */
export async function readCheckpointOwnSource(params: {
  branch: ConversationKnowledgeBranch;
  reference: ConversationKnowledgeReference;
  audienceKey: string;
  reader: SessionEntryCohortReader;
  check: () => void;
}) {
  return params.reader.withRead(
    { sessionKeys: [params.branch.sessionKey], includeParticipantRecords: true },
    params.check,
    (facts) => {
      const entry = facts.entries.find((row) => row.sessionKey === params.branch.sessionKey)?.entry;
      if (
        !entry ||
        entry.sessionId !== params.branch.sessionId ||
        entry.lifecycleRevision !== params.branch.lifecycleRevision ||
        params.reference.source.sessionId !== params.branch.sessionId
      ) {
        throw new PersonalConversationReadRefusedError("Checkpoint own source incarnation changed");
      }
      if (
        params.reference.source.lifecycleRevision !== entry.lifecycleRevision &&
        conversationKnowledgeHistoricalContributionIdentity(
          entry,
          params.branch,
          params.reference,
          params.branch.root,
        ) !== params.audienceKey
      ) {
        throw new PersonalConversationReadRefusedError(
          "Checkpoint historical own source is not currently private to this person",
        );
      }
      return facts.source;
    },
  );
}
