import { isDeepStrictEqual } from "node:util";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import {
  conversationKnowledgeAudienceIdentity,
  conversationKnowledgeParticipantIdentity,
  conversationKnowledgeContributionIdentity,
  conversationKnowledgeHistoricalContributionIdentity,
  hasOnlyConversationAgentActorChanges,
} from "../config/sessions/conversation-audience.js";
import {
  assertConversationBranchCreation,
  conversationBranchAuthorityFields as fields,
  consumeConversationBranchCreation,
} from "../config/sessions/conversation-branch-creation.js";
import { conversationKnowledgeContributionId } from "../config/sessions/conversation-knowledge-identity.js";
import {
  issuePersonalConversationContributionRange,
  type PersonalConversationContributionRange,
} from "../config/sessions/conversation-knowledge-source-custody.js";
import type { ConversationKnowledgeBranch } from "../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../config/sessions/conversation-knowledge.js";
import { assertSessionConversationRootEntry } from "../config/sessions/session-conversation-admission.js";
import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
} from "../config/sessions/session-source-authority.js";
import type { SessionTranscriptContextVersion } from "../config/sessions/session-transcript-context-version.types.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { PersonalConversationReadRefusedError } from "./session-mutation-authorization-error.js";
import { resolveSessionVisibility } from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import {
  preparePersonalContributionMetadata,
  type PersonalContributionMetadata,
} from "./session-transcript-personal-contribution-group.js";
import type { PersonalConversationReadParams } from "./session-transcript-personal-read.js";

type PersonalReadSource = Readonly<{
  agentId: string;
  canonicalKey: string;
  storePath: string;
  sessionId: string;
  lifecycleRevision: string | undefined;
  readSource: CapturedSessionEntryReadSource;
}>;
type PersonalReadCustody = {
  reads: Array<{
    held: Awaited<ReturnType<typeof prepareSessionMutationFacts>>;
    expected: PersonalReadSource;
    selectorPath: string;
    storeKey: string;
    members: string[];
    entry: InternalSessionEntry;
    root: boolean;
    attested: boolean;
  }>;
  sources: PersonalReadSource[];
  releases: Array<() => void>;
  references: number;
};
type PersonalAdmissionBinding = {
  target: ConversationKnowledgeBranch;
  participant: SessionParticipantIdentity;
  selected: readonly { agentId: string; sessionKey: string }[];
  selectedMode: ReturnType<typeof resolveAgentConversationMode>;
  contributionGroupDigest?: string;
  creatingDestination: boolean;
};

function releasePersonalReadCustody(custody: PersonalReadCustody, retireView: boolean) {
  if (retireView) {
    custody.references--;
  }
  if (custody.references > 0) {
    return;
  }
  const errors: unknown[] = [];
  // Failed terminal cleanup retains native ownership for a later release retry.
  for (let index = custody.releases.length - 1; index >= 0; index--) {
    try {
      custody.releases[index]!();
      custody.releases.splice(index, 1);
    } catch (error) {
      errors.push(error);
    }
  }
  throwSqliteLifecycleErrors(errors, "Personal transcript read release failed");
}

const personalAdmissionIssuer = Symbol("native-personal-admission");
/** Retains native row publications, never a former caller's execution or disclosure proof. */
class PreparedPersonalConversationAdmission {
  #custody: PersonalReadCustody;
  #binding: PersonalAdmissionBinding;
  #active = true;
  readonly byteLength: number;

  constructor(
    issuer: typeof personalAdmissionIssuer,
    custody: PersonalReadCustody,
    binding: PersonalAdmissionBinding,
  ) {
    if (issuer !== personalAdmissionIssuer) {
      throw new Error("Prepared personal admission requires its native read owner");
    }
    this.#custody = custody;
    this.#binding = structuredClone(binding);
    this.byteLength = Buffer.byteLength(
      JSON.stringify({ binding, reads: custody.reads.map(({ held: _held, ...read }) => read) }),
    );
    custody.references++;
    Object.freeze(this);
  }

  static acquire(value: unknown, binding: PersonalAdmissionBinding): PersonalReadCustody {
    if (
      typeof value !== "object" ||
      value === null ||
      !(#custody in value) ||
      !value.#active ||
      !isDeepStrictEqual(value.#binding, binding)
    ) {
      throw new PersonalConversationReadRefusedError(
        "Prepared personal admission changed or expired",
      );
    }
    value.#custody.references++;
    return value.#custody;
  }

  release() {
    const retireView = this.#active;
    this.#active = false;
    releasePersonalReadCustody(this.#custody, retireView);
  }
}
Object.freeze(PreparedPersonalConversationAdmission);
Object.freeze(PreparedPersonalConversationAdmission.prototype);
export type { PreparedPersonalConversationAdmission };

export async function preparePersonalConversationReadInternal(
  params: PersonalConversationReadParams,
  groupContributions?: readonly ConversationKnowledgeReference[],
  preparedGroupVersion?: SessionTranscriptContextVersion,
  preparedMetadata?: PersonalContributionMetadata,
) {
  const target = structuredClone(params.personal.target);
  const participant = structuredClone(params.personal.originalParticipant);
  const selected = params.sources.map(({ agentId, sessionKey }) => ({ agentId, sessionKey }));
  const creation = params.personal.targetCreation;
  const destination = params.personal.targetAudience;
  const rootEvidence = params.personal.rootEvidence;
  params.personal.assertCurrent();
  const creationSource = creation
    ? consumeConversationBranchCreation({
        creation,
        branch: target,
        participant,
        audience: destination,
      })
    : undefined;
  const original = composeSessionSourceAssertion([params.personal.assertCurrent, creation?.source]);
  original();
  const contributionMetadata =
    preparedMetadata ??
    (groupContributions
      ? await preparePersonalContributionMetadata(
          { ...params.personal, target, originalParticipant: participant },
          groupContributions,
        )
      : undefined);
  const contribution =
    params.personal.contribution && structuredClone(params.personal.contribution);
  const contributions = contributionMetadata
    ? contributionMetadata.contributions
    : contribution?.privateAudience || contribution?.readRange
      ? [contribution]
      : [];
  const contributionById = new Map<string, ConversationKnowledgeReference>();
  for (const reference of contributionMetadata ? [] : contributions) {
    const id = conversationKnowledgeContributionId(reference);
    if (
      contributionById.has(id) ||
      reference.retirement ||
      (groupContributions && !reference.privateAudience)
    ) {
      throw new PersonalConversationReadRefusedError(
        "Contribution group has invalid or duplicate ranges",
      );
    }
    contributionById.set(id, reference);
  }
  const custodyContributions = contributionMetadata ? contributions.slice(0, 1) : contributions;
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
      (source) =>
        source.agentId !== target.agentId ||
        (source.sessionKey === target.sessionKey &&
          (!contributions.length ||
            custodyContributions.some(
              (reference) =>
                reference.source.sessionKey !== target.sessionKey ||
                reference.source.sessionId !== target.sessionId ||
                reference.source.lifecycleRevision === target.lifecycleRevision,
            ))),
    )
  ) {
    throw new PersonalConversationReadRefusedError(
      "Personal conversation differences require an original same-person branch source",
    );
  }
  const audienceIdentity = conversationKnowledgeParticipantIdentity(participant);
  const rootValidation = contributions.length
    ? await import("../config/sessions/conversation-knowledge-store.js")
    : undefined;
  const validateRootEvidence = rootValidation?.assertNativeKnowledgeRootContribution;
  const validateGroup = () => {
    if (contributionMetadata) {
      rootValidation!.assertNativeKnowledgeRootContributionGroup(
        rootEvidence,
        target,
        contributionMetadata.rootProof,
      );
    }
  };
  original();
  // Validate each immutable range exactly once for this fresh root binding.
  // Subsequent guards recheck its issuer lifetime, not the whole range list.
  validateGroup();
  for (const reference of contributionMetadata ? [] : contributions) {
    if (!rootEvidence || !validateRootEvidence) {
      throw new PersonalConversationReadRefusedError(
        "Personal contribution requires native root evidence",
      );
    }
    validateRootEvidence(rootEvidence, target, reference);
  }
  const binding = {
    target,
    participant,
    selected,
    selectedMode,
    creatingDestination: Boolean(creation),
    ...(contributionMetadata ? { contributionGroupDigest: contributionMetadata.digest } : {}),
  };
  const reusingAdmission = params.preparedAdmission !== undefined;
  const custody: PersonalReadCustody = reusingAdmission
    ? PreparedPersonalConversationAdmission.acquire(params.preparedAdmission, binding)
    : { reads: [], sources: [], releases: [], references: 1 };
  const { reads, sources, releases } = custody;
  let active = true;
  let refusal: unknown;
  let revoked = false;
  let contributionVersion: SessionTranscriptContextVersion | undefined;
  const refuse = (error: unknown): never => {
    revoked = true;
    refusal = error;
    throw error;
  };
  const policy = () => {
    params.signal?.throwIfAborted();
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
    if (creation) {
      assertConversationBranchCreation({
        creation,
        branch: target,
        participant,
        audience: destination,
      });
    }
    if (contributions.length) {
      if (!rootEvidence) {
        throw new PersonalConversationReadRefusedError(
          "Personal contribution requires native root evidence",
        );
      }
      validateGroup();
      for (const reference of contributionMetadata ? [] : custodyContributions) {
        validateRootEvidence!(rootEvidence, target, reference);
      }
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
    if (
      sessionKey === target.sessionKey &&
      selected.some((source) => source.sessionKey === sessionKey)
    ) {
      // Self-history is only the exact old lifecycle, independently confirmed by
      // today's private enrollment. A current input endpoint alone is not proof.
      for (const reference of custodyContributions) {
        if (
          conversationKnowledgeHistoricalContributionIdentity(
            entry,
            { agentId: target.agentId, sessionKey },
            reference,
            target.root,
          ) !== audienceIdentity
        ) {
          throw new PersonalConversationReadRefusedError(
            "Historical self contribution has no current same-person custody",
          );
        }
      }
    }
    const destinationIdentity =
      destination &&
      destination.agentId === target.agentId &&
      destination.sessionKey === target.sessionKey &&
      sessionKey === target.sessionKey &&
      entry.publicShare === undefined &&
      conversationKnowledgeParticipantIdentity(destination.participant);
    let contributionIdentity: string | undefined;
    if (sessionKey !== target.sessionKey && contributions.length) {
      for (const reference of custodyContributions) {
        const identity =
          conversationKnowledgeContributionIdentity(
            entry,
            { agentId: target.agentId, sessionKey },
            reference,
          ) ??
          conversationKnowledgeHistoricalContributionIdentity(
            entry,
            { agentId: target.agentId, sessionKey },
            reference,
            target.root,
          );
        if (identity !== audienceIdentity) {
          throw new PersonalConversationReadRefusedError(
            "Personal contribution has no current same-person source custody",
          );
        }
        contributionIdentity = identity;
      }
    }
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
    const retireView = active;
    active = false;
    releasePersonalReadCustody(custody, retireView);
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
    if (!reusingAdmission) {
      const originalTarget = creationSource
        ? undefined
        : await hold({ agentId: target.agentId, sessionKey: target.sessionKey }, false);
      if (
        originalTarget &&
        (originalTarget.sessionId !== target.sessionId ||
          originalTarget.lifecycleRevision !== target.lifecycleRevision)
      ) {
        throw new PersonalConversationReadRefusedError(
          "Personal destination is not the original input incarnation",
        );
      }
      const originalRoot = await hold(
        { agentId: target.agentId, sessionKey: target.root.sessionKey },
        true,
      );
      if (
        !isDeepStrictEqual(originalRoot.readSource, creationSource ?? originalTarget?.readSource)
      ) {
        throw new PersonalConversationReadRefusedError(
          "Personal conversation root differs from the original physical store",
        );
      }
    }
    assertCurrent();
    for (const reference of custodyContributions) {
      if (
        selected.length !== 1 ||
        selected[0]?.agentId !== reference.source.agentId ||
        selected[0]?.sessionKey !== reference.source.sessionKey ||
        (reference.privateAudience &&
          conversationKnowledgeParticipantIdentity(reference.privateAudience.participant) !==
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
    if (!reusingAdmission) {
      for (const request of selected) {
        const source = await hold(request, false);
        if (!isDeepStrictEqual(source.readSource, reads[0]!.expected.readSource)) {
          throw new PersonalConversationReadRefusedError(
            "Personal conversation sources do not share the original physical store",
          );
        }
        sources.push(source);
      }
    }
    if (groupContributions) {
      const { validatePersonalContributionGroupAnchors } =
        await import("./session-transcript-personal-contribution-anchors.js");
      contributionVersion = await validatePersonalContributionGroupAnchors({
        contributions,
        source: sources[0]!,
        assertCurrent,
        signal: params.signal,
        preparedVersion: preparedGroupVersion,
      });
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
              ...(!read.root &&
              read.expected.canonicalKey === selected[0]?.sessionKey &&
              contributionVersion
                ? {
                    transcript: {
                      sessionId: read.expected.sessionId,
                      version: contributionVersion,
                      consistency: "prefix" as const,
                    },
                  }
                : {}),
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
    const grantSource = composeSessionSourceAssertion([original, source]);
    return {
      audience: "private-direct" as const,
      audienceIdentity,
      sources: Object.freeze(sources),
      contributionVersion,
      contributionMetadata,
      prepareAdmission() {
        assertCurrent();
        return new PreparedPersonalConversationAdmission(personalAdmissionIssuer, custody, binding);
      },
      selectContribution(
        reference: ConversationKnowledgeReference,
      ): PersonalConversationContributionRange | undefined {
        // Selection performs no custody or worker reads. The retained owner
        // checks the grant at every disclosure and COMMIT boundary.
        if (!active || revoked) {
          throw new PersonalConversationReadRefusedError("Contribution selection has expired");
        }
        const id = conversationKnowledgeContributionId(reference);
        const admitted = contributionMetadata
          ? contributionMetadata.findContribution(id)
          : contributionById.get(id);
        if (!admitted || !isDeepStrictEqual(admitted, reference)) {
          return undefined;
        }
        const current = sources.find((item) => item.canonicalKey === admitted.source.sessionKey);
        if (!current?.lifecycleRevision || current.sessionId !== admitted.source.sessionId) {
          return undefined;
        }
        return issuePersonalConversationContributionRange({
          reference: admitted,
          target,
          source: grantSource,
          range: {
            origin: admitted.origin,
            originalLifecycleRevision: admitted.source.lifecycleRevision,
            currentLifecycleRevision: current.lifecycleRevision,
            through: Object.freeze({ ...(admitted.readRange?.through ?? admitted.through) }),
            ...(contributionVersion ? { version: contributionVersion } : {}),
            ...(admitted.privateAudience
              ? {
                  from: Object.freeze({
                    ...(admitted.readRange?.admission ?? admitted.privateAudience.admission),
                  }),
                }
              : {}),
          },
        });
      },
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
      assertCurrent: grantSource,
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
