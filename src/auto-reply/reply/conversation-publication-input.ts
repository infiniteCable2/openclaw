import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import { bindConversationPublicationInput } from "../../config/sessions/conversation-publication-context.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { readMessageIdempotencyKey } from "../../config/sessions/transcript-message-identity.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

/** Bind before native input admission/steering, not after a model run has started. */
export function bindReplyConversationInputPublication(params: {
  followupRun: AgentTurnParams["followupRun"];
  entry: InternalSessionEntry | undefined;
  sessionKey: string | undefined;
  storePath: string | undefined;
  assertCurrent: SessionSourceAssertion;
}): void {
  const { followupRun, entry, sessionKey } = params;
  const recorder = followupRun.userTurnTranscriptRecorder;
  const topology = entry?.conversationTopology;
  const agentId = followupRun.run.agentId;
  const proof = followupRun.conversationAudience;
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
      conversationKnowledgeParticipantIdentity(followupRun.conversationParticipant)
  ) {
    return;
  }
  const sourceMode = resolveAgentConversationMode(followupRun.run.config, agentId);
  const assertCurrent = composeSessionSourceAssertion([
    params.assertCurrent,
    followupRun.assertSourceCurrent,
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
