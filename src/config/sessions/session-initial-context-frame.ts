import { isDeepStrictEqual } from "node:util";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { createRuntimeConfigSnapshotMatcher } from "../runtime-config-snapshot-match.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { conversationKnowledgeParticipantIdentity } from "./conversation-audience.js";
import {
  assertConversationBranchCreation,
  consumeConversationBranchCreation,
  type PreparedConversationBranchCreation,
} from "./conversation-branch-creation.js";
import { conversationKnowledgeContributionId } from "./conversation-knowledge-identity.js";
import {
  readPersonalConversationContributionCustody,
  type PersonalConversationContributionRange,
} from "./conversation-knowledge-source-custody.js";
import {
  assertNativeKnowledgeRootContribution,
  type NativeKnowledgeRootEvidence,
} from "./conversation-knowledge-store.js";
import {
  createProjectedInitialSessionContextEvents,
  type PreparedProjectedInitialSessionContext,
} from "./session-initial-context.js";
import type { SessionParticipantIdentity } from "./session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  prepareSessionSourceAuthority,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourcePredicate,
} from "./session-source-authority.js";

type FrameContext = Omit<
  PreparedProjectedInitialSessionContext,
  "events" | "targetSessionId" | "kind"
>;
type FramePreparation = {
  context: FrameContext;
  evidence: NativeKnowledgeRootEvidence;
  ranges: readonly PersonalConversationContributionRange[];
  participant: SessionParticipantIdentity;
  audience: ConversationPrivateAudience;
  source: SessionSourceAssertion;
  getRuntimeConfig(): OpenClawConfig;
};
const frameIssuer = Symbol("native-initial-root-frame");
const rootFields = [
  "sessionId",
  "lifecycleRevision",
  "createdActor",
  "visibility",
  "incognito",
] as const;
const borrowed = new WeakMap<
  SessionSourcePredicate,
  {
    context: PreparedProjectedInitialSessionContext;
    assertCurrent(): void;
  }
>();

/** A root preparation retains its original broker and donor custody; it never retargets a grant. */
class PreparedConversationKnowledgeInitialFrame {
  readonly #context: FrameContext;
  readonly #prepared: PreparedSessionSourceAuthority;
  readonly #rootPredicate: SessionSourcePredicate;
  readonly #check: () => void;
  readonly #participant: string;
  #active = true;
  #released = false;
  #releasing?: Promise<void>;

  constructor(
    issuer: typeof frameIssuer,
    params: FramePreparation,
    prepared: PreparedSessionSourceAuthority,
  ) {
    if (issuer !== frameIssuer) {
      throw new Error("Initial root frames require native source preparation");
    }
    this.#context = freezeJsonSnapshot(structuredClone(params.context));
    this.#prepared = prepared;
    const rootPredicate = prepared.checks.find(
      ({ predicate }) =>
        predicate.sessionKey === params.context.sourceSessionKey &&
        isDeepStrictEqual(predicate.source, params.context.source) &&
        predicate.expected?.sessionId === params.context.sourceEntry.sessionId &&
        predicate.expected?.lifecycleRevision === params.context.sourceEntry.lifecycleRevision &&
        rootFields.every((field) => predicate.fields.includes(field)),
    )?.predicate;
    if (!rootPredicate) {
      throw new Error("Initial root frame lacks native root custody");
    }
    this.#rootPredicate = rootPredicate;
    this.#participant = conversationKnowledgeParticipantIdentity(params.participant)!;
    const matchesConfig = createRuntimeConfigSnapshotMatcher(params.getRuntimeConfig());
    this.#check = () => {
      if (!this.#active) {
        throw new Error("Initial root frame has been released");
      }
      params.audience.assertCurrent();
      params.source();
      prepared.assertPreparedCurrent?.();
      if (
        !matchesConfig(params.getRuntimeConfig()) ||
        conversationKnowledgeParticipantIdentity(params.audience.participant) !== this.#participant
      ) {
        throw new Error("Initial root frame authority or configuration changed");
      }
    };
    this.#check();
    Object.freeze(this);
  }

  assertCurrent(): void {
    this.#check();
  }

  async release(): Promise<void> {
    this.#active = false;
    if (this.#released) {
      return;
    }
    const releasing = this.#releasing ?? Promise.resolve().then(() => this.#prepared.release?.());
    this.#releasing = releasing;
    try {
      await releasing;
      this.#released = true;
    } finally {
      if (this.#releasing === releasing) {
        this.#releasing = undefined;
      }
    }
  }

  static async borrow(
    this: void,
    params: {
      frame: PreparedConversationKnowledgeInitialFrame;
      creation: PreparedConversationBranchCreation;
      audience: ConversationPrivateAudience;
      assertCurrent: SessionSourceAssertion;
    },
  ): Promise<{ context: PreparedProjectedInitialSessionContext; source: SessionSourceAssertion }> {
    const { frame, creation } = params;
    if (!(frame instanceof PreparedConversationKnowledgeInitialFrame) || !(#context in frame)) {
      throw new Error("Initial root frame requires its native issuer");
    }
    frame.#check();
    const nativeSource = consumeConversationBranchCreation({
      creation,
      branch: creation.branch,
      participant: creation.participant,
      audience: params.audience,
    });
    if (
      conversationKnowledgeParticipantIdentity(creation.participant) !== frame.#participant ||
      creation.branch.agentId !== frame.#context.projection.branch.agentId ||
      creation.branch.storePath !== frame.#context.projection.branch.storePath ||
      !isDeepStrictEqual(creation.branch.root, frame.#context.projection.branch.root) ||
      !isDeepStrictEqual(nativeSource, frame.#context.source)
    ) {
      throw new Error("Initial root frame does not belong to the creating destination");
    }
    const check = () => {
      params.assertCurrent();
      frame.#check();
      assertConversationBranchCreation({
        creation,
        branch: creation.branch,
        participant: creation.participant,
        audience: params.audience,
      });
    };
    check();
    const projection = { ...frame.#context.projection, branch: creation.branch };
    const context: PreparedProjectedInitialSessionContext = freezeJsonSnapshot({
      ...frame.#context,
      kind: "prepared-root-projection",
      projection,
      targetSessionId: creation.branch.sessionId,
      events: createProjectedInitialSessionContextEvents({
        projection,
        targetSessionId: creation.branch.sessionId,
      }),
    });
    const seal: SessionSourcePredicate = {
      ...frame.#rootPredicate,
      transcript: {
        sessionId: frame.#context.sourceEntry.sessionId,
        version: frame.#context.sourceVersion,
        consistency: "prefix",
      },
    };
    borrowed.set(seal, { context, assertCurrent: check });
    const retained = Object.assign(check, {
      prepareSessionSource: async (): Promise<PreparedSessionSourceAuthority> => {
        check();
        return {
          ...frame.#prepared,
          assertCurrent: check,
          assertPreparedCurrent: check,
          // RootOwner owns this custody. Each borrower owns only its creation capability.
          release: undefined,
          checks: [
            ...frame.#prepared.checks,
            {
              predicate: seal,
              refuse: (): never => {
                throw new Error("Initial root frame prefix changed");
              },
            },
          ],
        };
      },
    });
    return {
      context,
      source: composeSessionSourceAssertion([params.assertCurrent, creation.source, retained]),
    };
  }
}
Object.freeze(PreparedConversationKnowledgeInitialFrame);
Object.freeze(PreparedConversationKnowledgeInitialFrame.prototype);
export type { PreparedConversationKnowledgeInitialFrame };
export const borrowPreparedConversationKnowledgeInitialFrame =
  PreparedConversationKnowledgeInitialFrame.borrow;

/** The native lifecycle host proves the exact payload before its worker wire representation exists. */
export function assertPreparedInitialSessionContextFrame(
  context: PreparedProjectedInitialSessionContext,
  sources: readonly SessionSourcePredicate[] | undefined,
): void {
  const proof = sources
    ?.map((source) => borrowed.get(source))
    .find((value) => value && isDeepStrictEqual(value.context, context));
  if (!proof) {
    throw new Error("Prepared initial root projection requires its retained native frame");
  }
  proof.assertCurrent();
}

/** Called off-turn after real native root/range selection; plain ranges and cached bytes grant nothing. */
export async function prepareConversationKnowledgeInitialFrame(
  params: FramePreparation,
): Promise<PreparedConversationKnowledgeInitialFrame> {
  params.source();
  params.audience.assertCurrent();
  const identity = conversationKnowledgeParticipantIdentity(params.participant);
  const { context } = params;
  if (
    !identity ||
    identity !== conversationKnowledgeParticipantIdentity(params.audience.participant) ||
    params.ranges.length !== context.projection.claims.length ||
    !params.ranges.length
  ) {
    throw new Error("Initial root frame requires original personal source custody");
  }
  const source = await prepareSessionSourceAuthority(params.source);
  try {
    for (const [index, claim] of context.projection.claims.entries()) {
      assertNativeKnowledgeRootContribution(
        params.evidence,
        context.projection.branch,
        claim.reference,
      );
      const range = params.ranges[index]!;
      readPersonalConversationContributionCustody({
        proof: range,
        reference: claim.reference,
        target: context.projection.branch,
      });
      if (
        !isDeepStrictEqual(range.version, claim.version) ||
        !isDeepStrictEqual(range.through, claim.through) ||
        !isDeepStrictEqual(range.from, claim.from) ||
        !source.checks.some((check) => isDeepStrictEqual(check.predicate, claim.predicate)) ||
        conversationKnowledgeParticipantIdentity(claim.reference.privateAudience?.participant) !==
          identity
      ) {
        throw new Error("Initial root frame changed an authorized original range");
      }
    }
    const claims = new Map(
      context.projection.claims.map((claim) => [
        conversationKnowledgeContributionId(claim.reference),
        claim,
      ]),
    );
    for (const packet of context.projection.packets) {
      if (
        claims.get(conversationKnowledgeContributionId(packet.receipt)) !==
        context.projection.claims[packet.sourceClaim]
      ) {
        throw new Error("Initial root frame packet lost its original claim");
      }
    }
    params.source();
    return new PreparedConversationKnowledgeInitialFrame(frameIssuer, params, source);
  } catch (error) {
    await source.release?.();
    throw error;
  }
}
