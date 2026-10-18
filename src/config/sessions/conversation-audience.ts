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
  )
    return "private-direct" as const;
  if (entry.chatType === "group" || entry.chatType === "channel" || entry.publicShare)
    return "shared" as const;
  return "unknown" as const;
}

/** Equality narrows a native read policy; this string never grants history by itself. */
export function conversationKnowledgeParticipantIdentity(
  identity: SessionParticipantIdentity | undefined,
) {
  if (identity?.type !== "profile" && identity?.type !== "remote") return;
  return JSON.stringify([participantIdentityNamespace(identity), identity.id]);
}

/** Exactly one recorded private person is required before two audiences can be compared. */
export function conversationKnowledgeAudienceIdentity(entry: Partial<InternalSessionEntry>) {
  if (
    conversationKnowledgeAudience(entry) !== "private-direct" ||
    entry.participantCount !== 1 ||
    entry.participants?.length !== 1
  )
    return;
  return conversationKnowledgeParticipantIdentity(entry.participants[0]?.identity);
}
