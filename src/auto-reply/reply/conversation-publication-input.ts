import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import { bindConversationPublicationInput } from "../../config/sessions/conversation-publication-context.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { readMessageIdempotencyKey } from "../../config/sessions/transcript-message-identity.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";

/** Bind before native input admission/steering, not after a model run has started. */
export function bindConversationInputPublication(params: {
  config: OpenClawConfig;
  agentId: string | undefined;
  recorder?: UserTurnTranscriptRecorder;
  participant?: SessionParticipantIdentity;
  audience?: ConversationPrivateAudience;
  entry: InternalSessionEntry | undefined;
  sessionKey: string | undefined;
  storePath: string | undefined;
  assertCurrent: SessionSourceAssertion;
}): void {
  const { entry, sessionKey, recorder, agentId, audience: proof } = params;
  const topology = entry?.conversationTopology;
  const participant = proof?.participant;
  const lifecycleRevision = entry?.lifecycleRevision;
  if (
    !recorder ||
    !agentId ||
    !sessionKey ||
    !lifecycleRevision ||
    entry?.incognito ||
    topology?.role !== "branch" ||
    entry.publicShare !== undefined ||
    !proof ||
    proof.agentId !== agentId ||
    proof.sessionKey !== sessionKey ||
    !participant ||
    (participant.type !== "remote" && participant.type !== "profile") ||
    conversationKnowledgeParticipantIdentity(participant) !==
      conversationKnowledgeParticipantIdentity(params.participant)
  ) {
    return;
  }
  const sourceMode = resolveAgentConversationMode(params.config, agentId);
  const assertCurrent = composeSessionSourceAssertion([
    params.assertCurrent,
    () => proof.assertCurrent(),
  ]);
  const source = { agentId, sessionKey, sessionId: entry.sessionId };
  bindConversationPublicationInput(recorder, {
    source,
    storePath: params.storePath,
    capture: () => {
      assertCurrent();
      const inputKey = readMessageIdempotencyKey(
        recorder.getPendingInputMessage?.() ?? recorder.message,
      );
      if (!inputKey) {
        return undefined;
      }
      return {
        assertCurrent,
        intent: {
          version: 1,
          kind: "utterance-observation",
          role: "user",
          inputKey,
          sourceMode,
          source: { sessionKey, sessionId: entry.sessionId, lifecycleRevision },
          root: {
            sessionKey: topology.rootSessionKey,
            sessionId: topology.rootSessionId,
            lifecycleRevision: topology.rootSessionLifecycleRevision,
          },
          privateAudience: { participant, admission: "self" },
        },
      };
    },
  });
}
