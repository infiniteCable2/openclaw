import { isDeepStrictEqual } from "node:util";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import {
  conversationKnowledgeAudienceIdentity,
  conversationKnowledgeParticipantIdentity,
  conversationKnowledgeContributionIdentity,
  hasOnlyConversationAgentActorChanges,
} from "../config/sessions/conversation-audience.js";
import type {
  ConversationKnowledgeBranch,
  NativeKnowledgeRootEvidence,
} from "../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../config/sessions/conversation-knowledge.js";
import { assertSessionConversationRootEntry } from "../config/sessions/session-conversation-admission.js";
import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import type { ConversationPrivateAudience } from "../sessions/conversation-private-audience.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveSessionVisibility } from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

/** An explicit native policy refusal, distinct from unavailable facts or worker failures. */
export class PersonalConversationReadRefusedError extends SessionMutationAuthorizationChangedError {
  constructor(message: string) {
    super({ code: "FORBIDDEN", message });
    this.name = "PersonalConversationReadRefusedError";
  }
}

export type PersonalConversationReadParams = {
  purpose: "conversation-differences";
  personal: {
    originalParticipant: SessionParticipantIdentity;
    assertCurrent: SessionSourceAssertion;
    target: ConversationKnowledgeBranch;
    targetAudience?: ConversationPrivateAudience;
    /** Selected native root report, not an arbitrary history range supplied by a tool. */
    contribution?: ConversationKnowledgeReference;
    rootEvidence?: NativeKnowledgeRootEvidence;
  };
  getRuntimeConfig(): OpenClawConfig;
  sources: readonly { agentId: string; sessionKey: string }[];
};

// These are the native audience, membership and root-admission facts consumed below.
const fields = [
  "sessionId",
  "lifecycleRevision",
  "conversationTopology",
  "chatType",
  "publicShare",
  "participantCount",
  "participants",
  "incognito",
  "createdVia",
  "createdActor",
  "visibility",
  "delivery",
  "parentSessionKey",
  "parentSessionId",
  "parentSessionLifecycleRevision",
  "spawnedBy",
  "spawnedBySessionId",
  "spawnDepth",
  "forkSource",
  "forkedFromParent",
  "owner",
  "archivedAt",
  "initializationPending",
  "mainRestartRecovery",
  "modelSelectionLocked",
  "pendingProjectGitUrl",
  "pendingWorktree",
  "providerReview",
] as const satisfies readonly (keyof InternalSessionEntry)[];

/** Internal purpose of the native read owner, never a general history or operator grant. */
export async function preparePersonalConversationRead(params: PersonalConversationReadParams) {
  const target = structuredClone(params.personal.target);
  const participant = structuredClone(params.personal.originalParticipant);
  const selected = params.sources.map(({ agentId, sessionKey }) => ({ agentId, sessionKey }));
  const original = params.personal.assertCurrent;
  const destination = params.personal.targetAudience;
  const rootEvidence = params.personal.rootEvidence;
  const contribution =
    params.personal.contribution && structuredClone(params.personal.contribution);
  original();
  const selectedMode = resolveAgentConversationMode(params.getRuntimeConfig(), target.agentId);
  if (
    (participant.type !== "profile" && participant.type !== "remote") ||
    !participant.id.trim() ||
    (participant.type === "profile" && participant.id === GATEWAY_OWNER_PROFILE_ID) ||
    !target.lifecycleRevision ||
    !selected.length ||
    selected.length + 2 > MAX_SESSION_ROW_FACTS_KEYS ||
    [
      target.sessionKey,
      target.root.sessionKey,
      ...selected.map((source) => source.sessionKey),
    ].some(
      (key) => isIncognitoSessionKey(key) || parseAgentSessionKey(key)?.agentId !== target.agentId,
    ) ||
    selected.some(
      (source) => source.agentId !== target.agentId || source.sessionKey === target.sessionKey,
    )
  ) {
    throw new PersonalConversationReadRefusedError(
      "Personal conversation differences require an original same-person branch source",
    );
  }
  const audienceIdentity = conversationKnowledgeParticipantIdentity(participant);
  const validateRootEvidence =
    contribution?.privateAudience || contribution?.readRange
      ? (await import("../config/sessions/conversation-knowledge-store.js"))
          .assertNativeKnowledgeRootContribution
      : undefined;
  original();
  type Held = Awaited<ReturnType<typeof prepareSessionMutationFacts>>;
  type Source = Readonly<{
    agentId: string;
    canonicalKey: string;
    storePath: string;
    sessionId: string;
    lifecycleRevision: string | undefined;
    readSource: CapturedSessionEntryReadSource;
  }>;
  const reads: Array<{
    held: Held;
    expected: Source;
    selectorPath: string;
    storeKey: string;
    members: string[];
    entry: InternalSessionEntry;
    root: boolean;
    attested: boolean;
  }> = [];
  const sources: Source[] = [];
  const releases: Array<() => void> = [];
  let active = true;
  let refusal: unknown;
  let revoked = false;
  const refuse = (error: unknown): never => {
    revoked = true;
    refusal = error;
    throw error;
  };
  const policy = () => {
    if (!active) {
      throw new PersonalConversationReadRefusedError(
        "Personal conversation read has been released",
      );
    }
    if (revoked) {
      throw refusal;
    }
    original();
    destination?.assertCurrent();
    if (contribution?.privateAudience || contribution?.readRange) {
      if (!rootEvidence) {
        throw new PersonalConversationReadRefusedError(
          "Personal contribution requires native root evidence",
        );
      }
      validateRootEvidence!(rootEvidence, target, contribution);
    }
    const cfg = params.getRuntimeConfig();
    if (resolveAgentConversationMode(cfg, target.agentId) !== selectedMode) {
      throw new PersonalConversationReadRefusedError(
        "Personal conversation difference mode changed",
      );
    }
    return cfg;
  };
  const checkEntry = (entry: InternalSessionEntry, isRoot: boolean, sessionKey: string) => {
    if (isRoot) {
      assertSessionConversationRootEntry(entry, target.root.sessionKey);
      if (
        entry.sessionId !== target.root.sessionId ||
        entry.lifecycleRevision !== target.root.lifecycleRevision
      ) {
        throw new PersonalConversationReadRefusedError(
          "Personal conversation root incarnation changed",
        );
      }
      return false;
    }
    // Quoted differences become recipient history. A private transport does not
    // hide that history from the Gateway readers of a non-draft session.
    if (sessionKey === target.sessionKey && resolveSessionVisibility(entry) !== "draft") {
      throw new PersonalConversationReadRefusedError(
        "Personal conversation destination is visible to other Gateway readers",
      );
    }
    const creator = sessionCreatorProfileId(entry.createdActor);
    if (
      sessionKey === target.sessionKey &&
      creator &&
      creator !== GATEWAY_OWNER_PROFILE_ID &&
      (participant.type !== "profile" || participant.id !== creator)
    ) {
      throw new PersonalConversationReadRefusedError(
        "Personal conversation destination has another Gateway profile creator",
      );
    }
    const membership = entry.conversationTopology;
    const destinationIdentity =
      destination &&
      destination.agentId === target.agentId &&
      destination.sessionKey === target.sessionKey &&
      sessionKey === target.sessionKey &&
      entry.publicShare === undefined &&
      conversationKnowledgeParticipantIdentity(destination.participant);
    const contributionIdentity =
      sessionKey !== target.sessionKey &&
      conversationKnowledgeContributionIdentity(
        entry,
        {
          agentId: target.agentId,
          sessionKey,
        },
        contribution,
      );
    if (
      entry.incognito ||
      !entry.lifecycleRevision ||
      (destinationIdentity ||
        contributionIdentity ||
        conversationKnowledgeAudienceIdentity(entry)) !== audienceIdentity ||
      membership?.role !== "branch" ||
      membership.rootSessionKey !== target.root.sessionKey ||
      membership.rootSessionId !== target.root.sessionId ||
      membership.rootSessionLifecycleRevision !== target.root.lifecycleRevision
    ) {
      throw new PersonalConversationReadRefusedError(
        "Personal conversation source audience or root is not the original person's",
      );
    }
    return destinationIdentity === audienceIdentity || contributionIdentity === audienceIdentity;
  };
  const checkMembers = (members: readonly string[], root: boolean) => {
    if (
      !root &&
      members.some((member) => participant.type !== "profile" || member !== participant.id)
    ) {
      throw new PersonalConversationReadRefusedError(
        "Personal conversation has another explicitly shared reader",
      );
    }
  };
  const assertCurrent = () => {
    try {
      const cfg = policy();
      for (const read of reads) {
        const facts = read.held.readCurrent(cfg);
        const current = facts.target;
        const expected = read.expected;
        const actorOnlyChange =
          read.attested && hasOnlyConversationAgentActorChanges(read.entry, current.entry);
        if (
          current.agentId !== expected.agentId ||
          current.canonicalKey !== expected.canonicalKey ||
          current.storePath !== read.selectorPath ||
          current.storeKey !== read.storeKey ||
          !isDeepStrictEqual(current.readSource, expected.readSource) ||
          !isDeepStrictEqual([...facts.membership].toSorted(), read.members) ||
          fields.some(
            (field) =>
              !(actorOnlyChange && (field === "participants" || field === "participantCount")) &&
              !isDeepStrictEqual(current.entry[field], read.entry[field]),
          )
        ) {
          throw new PersonalConversationReadRefusedError(
            "Personal conversation source changed after admission",
          );
        }
        checkEntry(current.entry, read.root, current.canonicalKey);
        checkMembers(read.members, read.root);
      }
    } catch (error) {
      refuse(error);
    }
  };
  const release = () => {
    active = false;
    const errors: unknown[] = [];
    for (let index = releases.length - 1; index >= 0; index--) {
      try {
        releases[index]!();
        releases.splice(index, 1);
      } catch (error) {
        errors.push(error);
      }
    }
    throwSqliteLifecycleErrors(errors, "Personal transcript read release failed");
  };
  const hold = async (request: { agentId: string; sessionKey: string }, root: boolean) => {
    assertCurrent();
    const held = await prepareSessionMutationFacts({ cfg: policy(), ...request });
    releases.push(() => held.release());
    assertCurrent();
    const facts = held.readCurrent(policy());
    const current = facts.target;
    const members = [...facts.membership].toSorted();
    if (
      current.agentId !== target.agentId ||
      current.canonicalKey !== request.sessionKey ||
      current.readSource?.path !== target.storePath ||
      typeof current.readSource.databaseIdentity !== "string" ||
      isIncognitoSessionKey(current.canonicalKey)
    ) {
      throw new PersonalConversationReadRefusedError(
        "Personal conversation source physical ownership changed",
      );
    }
    const attested = checkEntry(current.entry, root, current.canonicalKey);
    checkMembers(members, root);
    const expected = Object.freeze({
      agentId: current.agentId,
      canonicalKey: current.canonicalKey,
      // Transcript consumers require the held physical source, not its logical selector.
      storePath: current.readSource.path,
      sessionId: current.entry.sessionId,
      lifecycleRevision: current.entry.lifecycleRevision,
      readSource: Object.freeze({ ...current.readSource }),
    });
    reads.push({
      held,
      expected,
      selectorPath: current.storePath,
      storeKey: current.storeKey,
      members,
      entry: structuredClone(current.entry),
      root,
      attested,
    });
    assertCurrent();
    return expected;
  };
  try {
    const originalTarget = await hold(
      { agentId: target.agentId, sessionKey: target.sessionKey },
      false,
    );
    if (
      originalTarget.sessionId !== target.sessionId ||
      originalTarget.lifecycleRevision !== target.lifecycleRevision
    ) {
      throw new PersonalConversationReadRefusedError(
        "Personal destination is not the original input incarnation",
      );
    }
    const originalRoot = await hold(
      { agentId: target.agentId, sessionKey: target.root.sessionKey },
      true,
    );
    if (!isDeepStrictEqual(originalRoot.readSource, originalTarget.readSource)) {
      throw new PersonalConversationReadRefusedError(
        "Personal conversation root differs from the original physical store",
      );
    }
    if (contribution?.privateAudience || contribution?.readRange) {
      if (
        selected.length !== 1 ||
        selected[0]?.agentId !== contribution.source.agentId ||
        selected[0]?.sessionKey !== contribution.source.sessionKey ||
        (contribution.privateAudience &&
          conversationKnowledgeParticipantIdentity(contribution.privateAudience.participant) !==
            audienceIdentity)
      ) {
        throw new PersonalConversationReadRefusedError(
          "Personal contribution is not the original person's selected range",
        );
      }
      // The original native root read supplies held evidence; never rescan the
      // entire root once per contribution or trust a tool-shaped receipt object.
      policy();
    }
    for (const request of selected) {
      const source = await hold(request, false);
      if (!isDeepStrictEqual(source.readSource, originalTarget.readSource)) {
        throw new PersonalConversationReadRefusedError(
          "Personal conversation sources do not share the original physical store",
        );
      }
      sources.push(source);
    }
    const prepare = async (): Promise<PreparedSessionSourceAuthority> => {
      assertCurrent();
      return {
        assertCurrent,
        assertPreparedCurrent: () => {
          try {
            policy();
          } catch (error) {
            refuse(error);
          }
        },
        checks: reads.map((read) => {
          const current = read.attested ? read.held.readCurrent(policy()).target.entry : read.entry;
          if (read.attested && !hasOnlyConversationAgentActorChanges(read.entry, current)) {
            refuse(
              new PersonalConversationReadRefusedError(
                "Personal conversation recipients changed during source preparation",
              ),
            );
          }
          return {
            predicate: {
              source: read.expected.readSource,
              sessionKey: read.storeKey,
              fields: [...fields],
              // Keep every native COMMIT field, refreshing only proved internal actors.
              expected: structuredClone({
                ...read.entry,
                participants: current.participants,
                participantCount: current.participantCount,
              }),
              members: [...read.members],
            },
            refuse: () =>
              refuse(
                new PersonalConversationReadRefusedError(
                  "Personal conversation read facts changed before commit",
                ),
              ),
          };
        }),
      };
    };
    const source = Object.assign(assertCurrent, {
      prepareSessionSource: prepare,
      prepareSessionSourceScope: prepare,
    });
    return {
      sources: Object.freeze(sources),
      contributionRange:
        contribution?.privateAudience || contribution?.readRange
          ? Object.freeze({
              ...(contribution.privateAudience
                ? {
                    from: Object.freeze({
                      ...(contribution.readRange?.admission ??
                        contribution.privateAudience.admission),
                    }),
                  }
                : {}),
              through: Object.freeze({
                ...(contribution.readRange?.through ?? contribution.through),
              }),
            })
          : undefined,
      assertCurrent: composeSessionSourceAssertion([original, source]),
      release,
    };
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Personal read preparation cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
