import { isDeepStrictEqual } from "node:util";
import type {
  ConversationKnowledgeCheckpoint,
  PreparedConversationKnowledgeCheckpointCoverage,
} from "../../config/sessions/conversation-knowledge-checkpoint.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import type { PersonalConversationContributionRange } from "../../config/sessions/conversation-knowledge-source-custody.js";
import type {
  ConversationKnowledgeBranch,
  NativeKnowledgeRootEvidence,
} from "../../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import { prepareConversationKnowledgeInitialFrame } from "../../config/sessions/session-initial-context-frame.js";
import type {
  PreparedInitialSessionContextSourceClaim,
  PreparedProjectedInitialSessionContext,
} from "../../config/sessions/session-initial-context.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import {
  prepareSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourcePredicate,
} from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import type {
  PreparedRootKnowledgeContribution,
  PreparedRootKnowledgeRange,
} from "./conversation-knowledge-checkpoint-source.js";
import type { PreparedConversationKnowledgePacket } from "./conversation-knowledge-source-cache.js";

export type CheckpointInitialFrameInput = {
  checkpoint?: ConversationKnowledgeCheckpoint;
  coverage?: PreparedConversationKnowledgeCheckpointCoverage;
  tail: readonly PreparedRootKnowledgeContribution[];
};
export type PreparedInitialFrameRange = {
  claim: PreparedInitialSessionContextSourceClaim;
  range: PersonalConversationContributionRange;
};
type FrameSources = {
  references: readonly ConversationKnowledgeReference[];
  source(selectedProofs?: readonly SessionSourceAssertion[]): SessionSourceAssertion;
  verifyAll(
    references: readonly ConversationKnowledgeReference[],
    verified: (
      reference: ConversationKnowledgeReference,
      range: PreparedRootKnowledgeRange,
    ) => void,
    cachedPackets?: ReadonlyMap<string, PreparedConversationKnowledgePacket>,
    retainProof?: (source: SessionSourceAssertion) => void,
  ): Promise<boolean>;
};

/** Capture a conservative prefix before reading references; hydration must not advance its watermark. */
export function readCheckpointInitialRootSnapshot(
  reader: SessionEntryCohortReader,
  branch: ConversationKnowledgeBranch,
  source: SessionSourceAssertion,
) {
  return reader.withRead(
    {
      sessionKeys: [...new Set([reader.sessionKey, branch.root.sessionKey])],
      transcript: { sessionKey: branch.root.sessionKey, entryIds: [], includeContextVersion: true },
    },
    source,
    (facts) => ({
      source: facts.source,
      entry: facts.entries.find((row) => row.sessionKey === branch.root.sessionKey)?.entry,
      version: facts.transcript?.contextVersion,
    }),
  );
}

/** A bounded tail alone is never advertised as a complete captured root preparation. */
export async function prepareCheckpointInitialFrame(
  params: CheckpointInitialFrameInput & {
    branch: ConversationKnowledgeBranch;
    participant: SessionParticipantIdentity;
    audience: ConversationPrivateAudience;
    rootSnapshot: Awaited<ReturnType<typeof readCheckpointInitialRootSnapshot>> | undefined;
    evidence: NativeKnowledgeRootEvidence;
    sources: FrameSources;
    nativeRanges: ReadonlyMap<string, PreparedInitialFrameRange>;
    getRuntimeConfig: () => OpenClawConfig;
    workCheck: () => void;
  },
) {
  params.workCheck();
  const { sources, checkpoint, coverage } = params;
  if (
    !params.rootSnapshot ||
    !sources.references.length ||
    Boolean(checkpoint) !== Boolean(coverage)
  ) {
    return undefined;
  }
  coverage?.assertCheckpoint(checkpoint!);
  const originals = new Map(
    sources.references.map((reference) => [
      conversationKnowledgeContributionId(reference),
      reference,
    ]),
  );
  if (coverage && [...coverage.contributionIds()].some((id) => !originals.has(id))) {
    return undefined;
  }
  const tail = new Map(
    params.tail.map((value) => [conversationKnowledgeContributionId(value.reference), value]),
  );
  if (
    tail.size !== params.tail.length ||
    sources.references.some((reference) => {
      const id = conversationKnowledgeContributionId(reference);
      return coverage?.has(id)
        ? !coverage.matchesReference(reference)
        : !isDeepStrictEqual(tail.get(id)?.reference, reference);
    })
  ) {
    return undefined;
  }
  const cachedPackets = new Map(
    params.tail.map((value) => [
      conversationKnowledgeContributionId(value.reference),
      value.packet,
    ]),
  );
  const verified = new Map<string, PreparedRootKnowledgeRange>();
  const frameProofs = new Set<SessionSourceAssertion>();
  const complete = await sources.verifyAll(
    sources.references,
    (reference, range) => {
      verified.set(conversationKnowledgeContributionId(reference), range);
    },
    cachedPackets,
    (proof) => frameProofs.add(proof),
  );
  params.workCheck();
  if (!complete || verified.size !== sources.references.length) {
    return undefined;
  }
  const claims: PreparedInitialSessionContextSourceClaim[] = [];
  const ranges: PersonalConversationContributionRange[] = [];
  const packets: PreparedProjectedInitialSessionContext["projection"]["packets"][number][] = [];
  for (const reference of sources.references) {
    const id = conversationKnowledgeContributionId(reference);
    const selected = verified.get(id)!;
    const native = params.nativeRanges.get(id);
    if (
      !native ||
      !isDeepStrictEqual(native.claim, selected.claim) ||
      (coverage?.has(id) && !coverage.matchesReference(reference, selected))
    ) {
      return undefined;
    }
    const sourceClaim = claims.push(selected.claim) - 1;
    ranges.push(native.range);
    if (!coverage?.has(id)) {
      const value = tail.get(id)!;
      if (!value.packet.part.complete) {
        return undefined;
      }
      packets.push({
        receipt: reference,
        text: value.packet.part.text,
        offset: 0,
        nextOffset: value.packet.part.nextOffset ?? 0,
        complete: true,
        sourceClaim,
      });
    }
  }
  const original = sources.source([...frameProofs]);
  const root = params.rootSnapshot;
  params.workCheck();
  if (
    !root.entry ||
    !root.version?.generation ||
    typeof root.source.databaseIdentity !== "string"
  ) {
    return undefined;
  }
  const predicate: SessionSourcePredicate = {
    source: root.source,
    sessionKey: params.branch.root.sessionKey,
    fields: ["sessionId", "lifecycleRevision", "createdActor", "visibility", "incognito"],
    expected: root.entry,
    transcript: { sessionId: root.entry.sessionId, version: root.version, consistency: "prefix" },
  };
  const prefix = Object.assign(() => original(), {
    prepareSessionSource: async () => {
      const prepared = await prepareSessionSourceAuthority(original);
      return {
        ...prepared,
        checks: [
          ...prepared.checks,
          {
            predicate,
            refuse: (): never => {
              throw new Error("Prepared root frame watermark changed");
            },
          },
        ],
      };
    },
  });
  return prepareConversationKnowledgeInitialFrame({
    context: {
      source: { ...root.source, databaseIdentity: root.source.databaseIdentity },
      sourceSessionKey: params.branch.root.sessionKey,
      sourceEntry: {
        sessionId: root.entry.sessionId,
        lifecycleRevision: root.entry.lifecycleRevision,
      },
      sourceVersion: root.version,
      projection: { branch: params.branch, packets, claims, ...(checkpoint ? { checkpoint } : {}) },
    },
    evidence: params.evidence,
    ranges,
    participant: params.participant,
    audience: params.audience,
    source: prefix,
    getRuntimeConfig: params.getRuntimeConfig,
  });
}
