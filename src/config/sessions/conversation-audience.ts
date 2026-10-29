import { isDeepStrictEqual } from "node:util";
import type { ConversationKnowledgeReference } from "./conversation-knowledge.js";
import {
  participantIdentityNamespace,
  type SessionParticipantIdentity,
} from "./session-participant-identity.js";
import type { InternalSessionEntry } from "./types.js";

/** Audience facts never come from an address, a device name, or operator scope. */
export function conversationKnowledgeAudience(entry: Partial<InternalSessionEntry>) {
  if (
    entry.chatType === "direct" &&
    entry.publicShare === undefined &&
    (entry.participantCount ?? 0) <= 1
  ) {
    return "private-direct" as const;
  }
  if (entry.chatType === "group" || entry.chatType === "channel" || entry.publicShare) {
    return "shared" as const;
  }
  return "unknown" as const;
}

/** Equality narrows a native read policy; this string never grants history by itself. */
export function conversationKnowledgeParticipantIdentity(
  identity: SessionParticipantIdentity | undefined,
) {
  if (identity?.type !== "profile" && identity?.type !== "remote") {
    return undefined;
  }
  return JSON.stringify([participantIdentityNamespace(identity), identity.id]);
}

/** Only a separately proved recipient may tolerate internal actor bookkeeping. */
export function hasOnlyConversationAgentActorChanges(
  original: Pick<InternalSessionEntry, "participants" | "participantCount">,
  current: Pick<InternalSessionEntry, "participants" | "participantCount">,
): boolean {
  const before = original.participants ?? [];
  const after = current.participants ?? [];
  // A partial roster cannot prove that another person was not hidden by truncation.
  if (
    (original.participantCount ?? 0) !== before.length ||
    (current.participantCount ?? 0) !== after.length
  ) {
    return false;
  }
  return isDeepStrictEqual(
    before.filter((row) => row.identity.type !== "agent"),
    after.filter((row) => row.identity.type !== "agent"),
  );
}

/** Exactly one recorded private person is required before two audiences can be compared. */
export function conversationKnowledgeAudienceIdentity(entry: Partial<InternalSessionEntry>) {
  if (
    conversationKnowledgeAudience(entry) !== "private-direct" ||
    entry.participantCount !== 1 ||
    entry.participants?.length !== 1
  ) {
    return undefined;
  }
  return conversationKnowledgeParticipantIdentity(entry.participants[0]?.identity);
}

/** A complete current roster can ignore known internal actors, never unknown speakers. */
function conversationKnowledgeCurrentPersonIdentity(entry: Partial<InternalSessionEntry>) {
  if (!entry.participants || entry.participantCount !== entry.participants.length) {
    return undefined;
  }
  const participants = entry.participants.filter((row) => row.identity.type !== "agent");
  return conversationKnowledgeAudienceIdentity({
    ...entry,
    participants,
    participantCount: participants.length,
  });
}

/** A native saved contribution can attest only its exact turn, never the older session. */
export function conversationKnowledgeContributionIdentity(
  entry: Partial<InternalSessionEntry>,
  source: { agentId: string; sessionKey: string },
  contribution: ConversationKnowledgeReference | undefined,
) {
  if (
    entry.publicShare !== undefined ||
    !contribution?.privateAudience ||
    contribution.source.agentId !== source.agentId ||
    contribution.source.sessionKey !== source.sessionKey ||
    contribution.source.sessionId !== entry.sessionId ||
    contribution.source.lifecycleRevision !== entry.lifecycleRevision
  ) {
    return undefined;
  }
  return conversationKnowledgeParticipantIdentity(contribution.privateAudience.participant);
}

/** Current enrollment may authorize an old exact occurrence, never an old execution lease. */
export function conversationKnowledgeHistoricalContributionIdentity(
  entry: Partial<InternalSessionEntry>,
  source: { agentId: string; sessionKey: string },
  contribution: ConversationKnowledgeReference | undefined,
  root: { sessionKey: string; sessionId: string; lifecycleRevision: string },
) {
  const membership = entry.conversationTopology;
  if (
    entry.incognito ||
    !entry.lifecycleRevision ||
    !contribution?.privateAudience ||
    contribution.retirement ||
    contribution.source.agentId !== source.agentId ||
    contribution.source.sessionKey !== source.sessionKey ||
    contribution.source.sessionId !== entry.sessionId ||
    contribution.source.lifecycleRevision === entry.lifecycleRevision ||
    membership?.role !== "branch" ||
    membership.rootSessionKey !== root.sessionKey ||
    membership.rootSessionId !== root.sessionId ||
    membership.rootSessionLifecycleRevision !== root.lifecycleRevision
  ) {
    return undefined;
  }
  // This MUST be independent of the saved contribution's audience assertion.
  const current = conversationKnowledgeCurrentPersonIdentity(entry);
  return current &&
    current === conversationKnowledgeParticipantIdentity(contribution.privateAudience.participant)
    ? current
    : undefined;
}
