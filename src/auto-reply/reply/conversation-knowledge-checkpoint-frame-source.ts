import { isDeepStrictEqual } from "node:util";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import { prepareConversationKnowledgeCheckpointSelection } from "../../config/sessions/conversation-knowledge-checkpoint-admission.js";
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
import { isDeeplyFrozenPlainData } from "../../shared/immutable-data.js";
import type { InvalidCheckpointCachedPacket } from "./conversation-knowledge-checkpoint-range.js";
import type {
  PreparedRootKnowledgeContribution,
  PreparedRootKnowledgeRange,
} from "./conversation-knowledge-checkpoint-source.js";
import type { PreparedConversationKnowledgePacket } from "./conversation-knowledge-source-cache.js";

export type CheckpointInitialFrameInput = {
  checkpoint?: ConversationKnowledgeCheckpoint;
  coverage?: PreparedConversationKnowledgeCheckpointCoverage;
  tail: readonly PreparedRootKnowledgeContribution[];
  invalidCached?: InvalidCheckpointCachedPacket;
};
export type PreparedInitialFrameRange = {
  claim: PreparedInitialSessionContextSourceClaim;
  range: PersonalConversationContributionRange;
};
type FramePacket = PreparedProjectedInitialSessionContext["projection"]["packets"][number];
const retainedFramePackets = new WeakMap<PreparedRootKnowledgeContribution, FramePacket>();

/** Packet bytes have no read authority. Each publication proves its current range separately. */
function projectFramePacket(value: PreparedRootKnowledgeContribution, sourceClaim: number) {
  const retained = retainedFramePackets.get(value);
  if (retained?.sourceClaim === sourceClaim) {
    return retained;
  }
  const packet: FramePacket = {
    receipt: value.reference,
    text: value.packet.part.text,
    offset: 0,
    nextOffset: value.packet.part.nextOffset ?? 0,
    complete: true,
    sourceClaim,
  };
  if (isDeeplyFrozenPlainData(value)) {
    Object.freeze(packet);
    retainedFramePackets.set(value, packet);
  }
  return packet;
}

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
    invalidCached?: InvalidCheckpointCachedPacket,
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
    reader: SessionEntryCohortReader;
    signal: AbortSignal;
    rootSnapshot: Awaited<ReturnType<typeof readCheckpointInitialRootSnapshot>> | undefined;
    evidence: NativeKnowledgeRootEvidence;
    sources: FrameSources;
    nativeRanges: ReadonlyMap<string, PreparedInitialFrameRange>;
    getRuntimeConfig: () => OpenClawConfig;
    workCheck: () => void;
  },
) {
  params.workCheck();
  const { sources, coverage } = params;
  let { checkpoint } = params;
  if (
    !params.rootSnapshot ||
    (!sources.references.length && !checkpoint) ||
    Boolean(checkpoint) !== Boolean(coverage)
  ) {
    return undefined;
  }
  coverage?.assertCheckpoint(checkpoint!);
  const references = sources.references.filter(
    (reference) => !coverage?.has(conversationKnowledgeContributionId(reference)),
  );
  const tail = new Map(
    params.tail.map((value) => [conversationKnowledgeContributionId(value.reference), value]),
  );
  if (
    tail.size !== params.tail.length ||
    references.some((reference) => {
      const id = conversationKnowledgeContributionId(reference);
      return !isDeepStrictEqual(tail.get(id)?.reference, reference);
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
  const invalid = new Map<
    string,
    { reference: ConversationKnowledgeReference; packet: PreparedConversationKnowledgePacket }
  >();
  const complete = await sources.verifyAll(
    references,
    (reference, range) => {
      verified.set(conversationKnowledgeContributionId(reference), range);
    },
    cachedPackets,
    (proof) => frameProofs.add(proof),
    (reference, packet) =>
      invalid.set(conversationKnowledgeContributionId(reference), { reference, packet }),
  );
  params.workCheck();
  for (const { reference, packet } of invalid.values()) {
    params.invalidCached?.(reference, packet);
  }
  if (!complete || verified.size !== references.length) {
    return undefined;
  }
  const claims: PreparedInitialSessionContextSourceClaim[] = [];
  const ranges: PersonalConversationContributionRange[] = [];
  const packets: FramePacket[] = [];
  for (const reference of references) {
    const id = conversationKnowledgeContributionId(reference);
    const selected = verified.get(id)!;
    const native = params.nativeRanges.get(id);
    if (!native || !isDeepStrictEqual(native.claim, selected.claim)) {
      return undefined;
    }
    const sourceClaim = claims.push(selected.claim) - 1;
    ranges.push(native.range);
    const value = tail.get(id)!;
    if (!value.packet.part.complete) {
      return undefined;
    }
    packets.push(projectFramePacket(value, sourceClaim));
  }
  const original = sources.source([...frameProofs]);
  const checkpointSelection =
    checkpoint && coverage
      ? await prepareConversationKnowledgeCheckpointSelection({
          branch: params.branch,
          checkpoint,
          coverage,
          audienceKey: conversationKnowledgeParticipantIdentity(params.participant)!,
          reader: params.reader,
          source: original,
          signal: params.signal,
        })
      : undefined;
  if (checkpoint && !checkpointSelection) {
    return undefined;
  }
  checkpoint = checkpointSelection?.checkpoint;
  const rootSource = checkpointSelection
    ? checkpointSelection.source({
        branch: params.branch,
        checkpoint: checkpoint!,
        audienceKey: conversationKnowledgeParticipantIdentity(params.participant)!,
        source: original,
      })
    : original;
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
  const prefix = Object.assign(() => rootSource(), {
    prepareSessionSource: async () => {
      const prepared = await prepareSessionSourceAuthority(rootSource);
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
    checkpointSelection,
    ranges,
    participant: params.participant,
    audience: params.audience,
    source: prefix,
    getRuntimeConfig: params.getRuntimeConfig,
  });
}
