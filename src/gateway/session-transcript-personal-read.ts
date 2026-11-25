import { isDeepStrictEqual } from "node:util";
import type { PreparedConversationBranchCreation } from "../config/sessions/conversation-branch-creation.js";
import type {
  ConversationKnowledgeBranch,
  NativeKnowledgeRootEvidence,
} from "../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../config/sessions/conversation-knowledge.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { SessionTranscriptContextVersion } from "../config/sessions/session-transcript-context-version.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConversationPrivateAudience } from "../sessions/conversation-private-audience.js";
import { PersonalConversationReadRefusedError } from "./session-mutation-authorization-error.js";
import type { PersonalReadSource } from "./session-transcript-personal-admission.js";
import type { PersonalContributionMetadata } from "./session-transcript-personal-contribution-group.js";
import {
  preparePersonalConversationReadInternal,
  type PreparedPersonalConversationAdmission,
} from "./session-transcript-personal-custody.js";

export { PersonalConversationReadRefusedError };
export type { PreparedPersonalConversationAdmission };

/** A denial-only view of the native source publication, never a read grant. */
export type RetainedLegacyConversationSourceDenial = {
  isCurrent(cfg: OpenClawConfig): boolean;
  release(): void;
};

export type PersonalConversationReadParams = {
  retainLegacySourceDenial?(denial: RetainedLegacyConversationSourceDenial): boolean;
  purpose: "conversation-differences";
  signal?: AbortSignal;
  /** Internal native custody only; the current caller still supplies all disclosure proofs. */
  preparedAdmission?: PreparedPersonalConversationAdmission;
  personal: {
    originalParticipant: SessionParticipantIdentity;
    assertCurrent: SessionSourceAssertion;
    target: ConversationKnowledgeBranch;
    targetAudience?: ConversationPrivateAudience;
    /** Native creation-bound disclosure proof for the genuinely absent destination. */
    targetCreation?: PreparedConversationBranchCreation;
    /** Selected native root report, not an arbitrary history range supplied by a tool. */
    contribution?: ConversationKnowledgeReference;
    /** Exact immutable off-turn selection; cannot be combined with a single contribution. */
    contributionGroup?: PreparedPersonalConversationContributionGroup;
    rootEvidence?: NativeKnowledgeRootEvidence;
  };
  getRuntimeConfig(): OpenClawConfig;
  sources: readonly { agentId: string; sessionKey: string }[];
};

const contributionGroupIssuer = Symbol("native-personal-contribution-group");
/** Retains native custody and an exact range set, never a representative contribution's authority. */
class PreparedPersonalConversationContributionGroup {
  readonly #admission: PreparedPersonalConversationAdmission;
  readonly #metadata: PersonalContributionMetadata;
  readonly #version: SessionTranscriptContextVersion;
  readonly #source: PersonalReadSource;
  #active = true;
  readonly byteLength: number;
  readonly ownedByteLength: number;

  constructor(
    issuer: typeof contributionGroupIssuer,
    admission: PreparedPersonalConversationAdmission,
    metadata: PersonalContributionMetadata,
    version: SessionTranscriptContextVersion,
    source: PersonalReadSource,
  ) {
    if (issuer !== contributionGroupIssuer) {
      throw new Error("Contribution group requires native admission");
    }
    this.#admission = admission;
    this.#metadata = metadata;
    this.#version = Object.freeze({ ...version });
    this.#source = source;
    this.byteLength = admission.byteLength + metadata.byteLength;
    this.ownedByteLength = admission.byteLength + Buffer.byteLength(JSON.stringify(version)) + 128;
    Object.freeze(this);
  }

  static acquire(value: unknown) {
    if (typeof value !== "object" || value === null || !(#admission in value) || !value.#active) {
      throw new PersonalConversationReadRefusedError(
        "Prepared contribution group changed or expired",
      );
    }
    return {
      admission: value.#admission,
      contributions: value.#metadata.contributions,
      metadata: value.#metadata,
      version: value.#version,
      source: value.#source,
    };
  }

  release() {
    this.#active = false;
    // The underlying admission keeps unfinished native cleanup for retry.
    this.#admission.release();
  }
}
Object.freeze(PreparedPersonalConversationContributionGroup);
Object.freeze(PreparedPersonalConversationContributionGroup.prototype);

export type { PreparedPersonalConversationContributionGroup };

/** Internal purpose of the native read owner, never a general history or operator grant. */
export async function preparePersonalConversationRead(params: PersonalConversationReadParams) {
  if (params.personal.contributionGroup) {
    if (params.personal.contribution || params.preparedAdmission) {
      throw new PersonalConversationReadRefusedError(
        "Contribution group cannot expand another admission",
      );
    }
    const group = PreparedPersonalConversationContributionGroup.acquire(
      params.personal.contributionGroup,
    );
    return preparePersonalConversationReadInternal(
      { ...params, preparedAdmission: group.admission },
      group.contributions,
      group.version,
      group.metadata,
    );
  }
  return preparePersonalConversationReadInternal(params);
}

export async function preparePersonalConversationContributionGroup(
  params: Omit<PersonalConversationReadParams, "personal" | "preparedAdmission"> & {
    personal: Omit<
      PersonalConversationReadParams["personal"],
      "contribution" | "contributionGroup"
    > & {
      contributions: readonly ConversationKnowledgeReference[];
      previousGroup?: PreparedPersonalConversationContributionGroup;
    };
  },
): Promise<PreparedPersonalConversationContributionGroup> {
  const { contributions: supplied, previousGroup, ...personal } = params.personal;
  const contributions = structuredClone(supplied);
  if (!contributions.length || params.sources.length !== 1) {
    throw new PersonalConversationReadRefusedError("Contribution group requires one exact source");
  }
  const originalSource = contributions[0]!.source;
  if (contributions.some((reference) => !isDeepStrictEqual(reference.source, originalSource))) {
    throw new PersonalConversationReadRefusedError("Contribution group mixes source incarnations");
  }
  const previous =
    previousGroup && PreparedPersonalConversationContributionGroup.acquire(previousGroup);
  const prefixLength = previous?.contributions.length ?? 0;
  const anchorPrefix =
    previous &&
    prefixLength < contributions.length &&
    previous.contributions.every((reference, index) =>
      isDeepStrictEqual(reference, contributions[index]),
    )
      ? { source: previous.source, version: previous.version, length: prefixLength }
      : undefined;
  const grant = await preparePersonalConversationReadInternal(
    { ...params, personal },
    contributions,
    undefined,
    undefined,
    anchorPrefix,
  );
  try {
    if (!grant.contributionVersion || !grant.contributionMetadata) {
      throw new PersonalConversationReadRefusedError("Contribution group has no native prefix");
    }
    return new PreparedPersonalConversationContributionGroup(
      contributionGroupIssuer,
      grant.prepareAdmission(),
      grant.contributionMetadata,
      grant.contributionVersion,
      grant.sources[0]!,
    );
  } finally {
    grant.release();
  }
}
