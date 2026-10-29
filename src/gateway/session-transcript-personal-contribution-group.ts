import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { conversationKnowledgeParticipantIdentity } from "../config/sessions/conversation-audience.js";
import { conversationKnowledgeContributionId } from "../config/sessions/conversation-knowledge-identity.js";
import type { NativeKnowledgeRootContributionGroup } from "../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../config/sessions/conversation-knowledge.js";
import { PersonalConversationReadRefusedError } from "./session-mutation-authorization-error.js";
import type { PersonalConversationReadParams } from "./session-transcript-personal-read.js";

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
