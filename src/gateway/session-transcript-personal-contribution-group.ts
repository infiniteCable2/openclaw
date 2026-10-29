import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { conversationKnowledgeParticipantIdentity } from "../config/sessions/conversation-audience.js";
import { conversationKnowledgeContributionId } from "../config/sessions/conversation-knowledge-identity.js";
import type { NativeKnowledgeRootContributionGroup } from "../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../config/sessions/conversation-knowledge.js";
import type { SessionTranscriptContextVersion } from "../config/sessions/session-transcript-context-version.types.js";
import {
  PersonalConversationReadRefusedError,
  type PersonalConversationReadParams,
  type PreparedPersonalConversationAdmission,
} from "./session-transcript-personal-read.js";

const contributionGroupIssuer = Symbol("native-personal-contribution-group");
export type PersonalContributionMetadata = Readonly<{
  contributions: readonly ConversationKnowledgeReference[];
  digest: string;
  rootProof: NativeKnowledgeRootContributionGroup;
  byteLength: number;
  findContribution(id: string): ConversationKnowledgeReference | undefined;
}>;
type SharedContributionSet = Omit<PersonalContributionMetadata, "rootProof">;
const sharedContributionSets = new Map<string, WeakRef<SharedContributionSet>>();

/** Off-turn validation; the private map and frozen references can be reused without rescanning. */
export async function preparePersonalContributionMetadata(
  personal: PersonalConversationReadParams["personal"],
  supplied: readonly ConversationKnowledgeReference[],
): Promise<PersonalContributionMetadata> {
  const serialized = JSON.stringify(supplied);
  const digest = sha256Hex(serialized);
  const cached = sharedContributionSets.get(digest)?.deref();
  const contributions = cached?.contributions ?? freezeReference(structuredClone(supplied));
  const byId = new Map<string, ConversationKnowledgeReference>();
  const first = contributions[0];
  const audience = conversationKnowledgeParticipantIdentity(personal.originalParticipant);
  if (!first) {
    throw new PersonalConversationReadRefusedError("Contribution group requires an exact source");
  }
  for (const reference of contributions) {
    const id = conversationKnowledgeContributionId(reference);
    if (
      byId.has(id) ||
      reference.retirement ||
      !reference.privateAudience ||
      !isDeepStrictEqual(reference.source, first.source) ||
      conversationKnowledgeParticipantIdentity(reference.privateAudience.participant) !== audience
    ) {
      throw new PersonalConversationReadRefusedError(
        "Contribution group has invalid or mixed ranges",
      );
    }
    byId.set(id, reference);
  }
  const { prepareNativeKnowledgeRootContributionGroup } =
    await import("../config/sessions/conversation-knowledge-store.js");
  const rootProof = prepareNativeKnowledgeRootContributionGroup(
    personal.rootEvidence,
    personal.target,
    contributions,
  );
  const shared =
    cached ??
    Object.freeze({
      contributions,
      digest,
      byteLength: Buffer.byteLength(serialized),
      findContribution: (id: string) => byId.get(id),
    });
  if (!cached) {
    for (const [key, value] of sharedContributionSets) {
      if (!value.deref()) {
        sharedContributionSets.delete(key);
      }
    }
    sharedContributionSets.set(digest, new WeakRef(shared));
    while (sharedContributionSets.size > 128) {
      sharedContributionSets.delete(sharedContributionSets.keys().next().value!);
    }
  }
  // Retain the shared owner, not a spread copy that would expire its weak registry entry.
  return Object.freeze({
    contributions: shared.contributions,
    digest: shared.digest,
    byteLength: shared.byteLength,
    rootProof,
    findContribution: (id: string) => shared.findContribution(id),
  });
}

function freezeReference<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeReference(child);
    }
    Object.freeze(value);
  }
  return value;
}
/** Retains native custody and an exact range set, never a representative contribution's authority. */
export class PreparedPersonalConversationContributionGroup {
  readonly #admission: PreparedPersonalConversationAdmission;
  readonly #metadata: PersonalContributionMetadata;
  readonly #version: SessionTranscriptContextVersion;
  #active = true;
  readonly byteLength: number;
  readonly ownedByteLength: number;

  constructor(
    issuer: typeof contributionGroupIssuer,
    admission: PreparedPersonalConversationAdmission,
    metadata: PersonalContributionMetadata,
    version: SessionTranscriptContextVersion,
  ) {
    if (issuer !== contributionGroupIssuer) {
      throw new Error("Contribution group requires native admission");
    }
    this.#admission = admission;
    this.#metadata = metadata;
    this.#version = Object.freeze({ ...version });
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

export async function preparePersonalConversationContributionGroup(
  params: Omit<PersonalConversationReadParams, "personal" | "preparedAdmission"> & {
    personal: Omit<
      PersonalConversationReadParams["personal"],
      "contribution" | "contributionGroup"
    > & {
      contributions: readonly ConversationKnowledgeReference[];
    };
  },
): Promise<PreparedPersonalConversationContributionGroup> {
  const { contributions: supplied, ...personal } = params.personal;
  const contributions = structuredClone(supplied);
  if (!contributions.length || params.sources.length !== 1) {
    throw new PersonalConversationReadRefusedError("Contribution group requires one exact source");
  }
  const originalSource = contributions[0]!.source;
  if (contributions.some((reference) => !isDeepStrictEqual(reference.source, originalSource))) {
    throw new PersonalConversationReadRefusedError("Contribution group mixes source incarnations");
  }
  const { preparePersonalConversationGroupRead } =
    await import("./session-transcript-personal-read.js");
  const grant = await preparePersonalConversationGroupRead({ ...params, personal }, contributions);
  try {
    if (!grant.contributionVersion || !grant.contributionMetadata) {
      throw new PersonalConversationReadRefusedError("Contribution group has no native prefix");
    }
    return new PreparedPersonalConversationContributionGroup(
      contributionGroupIssuer,
      grant.prepareAdmission(),
      grant.contributionMetadata,
      grant.contributionVersion,
    );
  } finally {
    grant.release();
  }
}
