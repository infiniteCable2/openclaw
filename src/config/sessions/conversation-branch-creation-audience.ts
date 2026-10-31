import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { conversationKnowledgeParticipantIdentity } from "./conversation-audience.js";
import { sessionCreatorProfileId } from "./session-entry-provenance.js";
import type { InternalSessionEntry } from "./types.js";

/** Eligibility for optional private copying, never source authority or creation permission. */
export function isConversationBranchCreationAudienceConfirmed(params: {
  agentId: string;
  sessionKey: string;
  entry: InternalSessionEntry;
  audience?: ConversationPrivateAudience;
}): boolean {
  const { audience, entry } = params;
  if (!audience) {
    return false;
  }
  audience.assertCurrent();
  const participant = audience.participant;
  const identity = conversationKnowledgeParticipantIdentity(participant);
  const creator = sessionCreatorProfileId(entry.createdActor);
  return Boolean(
    identity &&
    participant.id.trim() &&
    !(participant.type === "profile" && participant.id === GATEWAY_OWNER_PROFILE_ID) &&
    audience.agentId === params.agentId &&
    audience.sessionKey === params.sessionKey &&
    entry.visibility === "draft" &&
    entry.publicShare === undefined &&
    !entry.incognito &&
    (!creator ||
      creator === GATEWAY_OWNER_PROFILE_ID ||
      (participant.type === "profile" && creator === participant.id)) &&
    (entry.participantCount ?? 0) === (entry.participants?.length ?? 0) &&
    !entry.participants?.some(
      ({ identity: candidate }) =>
        candidate.type !== "agent" &&
        conversationKnowledgeParticipantIdentity(candidate) !== identity,
    ),
  );
}
