import { conversationKnowledgeParticipantIdentity } from "../config/sessions/conversation-audience.js";
import type { ConversationPublicationIntent } from "../config/sessions/conversation-publication.types.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptMessageAppendResult,
} from "../config/sessions/session-accessor.types.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConversationPrivateAudience } from "../sessions/conversation-private-audience.js";
import type { ClientVoiceConfirmationUtteranceContext } from "./client-voice-confirmation.js";
import type { ClientVoiceSessionSource } from "./client-voice-session-source.js";

/** Keep the captured intent paired with its original live source at the append boundary. */
export function voiceConversationAppendOptions(
  publication: ReturnType<typeof prepareVoiceConversationPublication>,
) {
  return publication
    ? {
        conversationPublication: publication.intent,
        preparation: { source: publication.assertCurrent },
      }
    : {};
}

/** Keep postcommit effects ordered without loading their runtimes for pure capture callers. */
export async function publishVoiceConversationCommit(params: {
  appended: TranscriptMessageAppendResult<unknown>;
  sessionTarget: SessionTranscriptWriteScope;
  sessionEntry: InternalSessionEntry;
  input: {
    agentId: string;
    entryId: string;
    text: string;
    role: "user" | "assistant";
    participant?: SessionParticipantIdentity;
    config?: OpenClawConfig;
  };
  source: Pick<ClientVoiceSessionSource, "options" | "assertCurrent">;
  publication: ReturnType<typeof prepareVoiceConversationPublication>;
  confirmation?: ClientVoiceConfirmationUtteranceContext | null;
  timestamp: number;
  effects: {
    recordClientVoiceConfirmationTranscriptAppend: typeof import("./client-voice-confirmation.js").recordClientVoiceConfirmationTranscriptAppend;
    publishTranscriptUpdate: typeof import("../config/sessions/session-accessor.js").publishTranscriptUpdate;
    startConversationKnowledgePublication: typeof import("../config/sessions/conversation-publication-reconcile.js").startConversationKnowledgePublication;
    recordVoiceConversationParticipant: typeof import("./voice-conversation-knowledge.js").recordVoiceConversationParticipant;
  };
}): Promise<void> {
  const { appended, sessionTarget, sessionEntry, input, source, confirmation, effects } = params;
  // Publish the committed row before fallible bookkeeping; a retry can deduplicate it.
  if (confirmation) {
    effects.recordClientVoiceConfirmationTranscriptAppend({
      confirmation,
      entryId: input.entryId,
      text: input.text,
      appended: appended.appended,
    });
  }
  if (appended.appended) {
    await effects.publishTranscriptUpdate(
      { ...sessionTarget, sessionId: sessionEntry.sessionId },
      { message: appended.message, messageId: appended.messageId },
    );
  }
  if (appended.anchor && sessionEntry.lifecycleRevision && input.config) {
    if (params.publication) {
      effects.startConversationKnowledgePublication({
        agentId: input.agentId,
        path: appended.anchor.storePath,
        env: source.options.env,
      });
    }
    await effects.recordVoiceConversationParticipant({
      anchor: appended.anchor,
      lifecycleRevision: sessionEntry.lifecycleRevision,
      role: input.role,
      participant: input.participant,
      fresh: appended.appended,
      timestamp: params.timestamp,
      env: source.options.env,
      assertCurrent: source.assertCurrent,
    });
  }
}

/** Original ingress facts precede COMMIT; the transaction supplies this utterance's anchor. */
export function prepareVoiceConversationPublication(params: {
  agentId: string;
  sessionKey: string;
  entry: InternalSessionEntry;
  sourceMode: "native" | "branches";
  role: "user" | "assistant";
  participant?: SessionParticipantIdentity;
  destinationAudience?: ConversationPrivateAudience;
  assertCurrent: SessionSourceAssertion;
}): { intent: ConversationPublicationIntent; assertCurrent: SessionSourceAssertion } | undefined {
  params.assertCurrent();
  const { entry } = params;
  const topology = entry.conversationTopology;
  if (entry.incognito || !entry.lifecycleRevision || topology?.role !== "branch") {
    return undefined;
  }
  const audience = params.destinationAudience;
  const participant = audience?.participant;
  const privateAudience =
    audience?.agentId === params.agentId &&
    audience.sessionKey === params.sessionKey &&
    participant &&
    (participant.type === "profile" || participant.type === "remote") &&
    (params.role === "assistant" ||
      conversationKnowledgeParticipantIdentity(params.participant) ===
        conversationKnowledgeParticipantIdentity(participant))
      ? { participant, admission: "self" as const }
      : undefined;
  const assertCurrent = composeSessionSourceAssertion([
    params.assertCurrent,
    ...(privateAudience ? [() => audience!.assertCurrent()] : []),
  ]);
  assertCurrent();
  return {
    intent: structuredClone({
      version: 1,
      kind: "utterance-observation",
      role: params.role,
      sourceMode: params.sourceMode,
      source: {
        sessionKey: params.sessionKey,
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
      },
      root: {
        sessionKey: topology.rootSessionKey,
        sessionId: topology.rootSessionId,
        lifecycleRevision: topology.rootSessionLifecycleRevision,
      },
      ...(privateAudience ? { privateAudience } : {}),
    }),
    assertCurrent,
  };
}
