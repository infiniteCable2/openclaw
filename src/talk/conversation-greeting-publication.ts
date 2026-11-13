import { captureCommandOwnerAssertion } from "../auto-reply/command-owner-authority.js";
import { readChannelContextGatewayContextResolver } from "../channels/message-access/admission-evidence.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import { startConversationKnowledgePublication } from "../config/sessions/conversation-publication-reconcile.js";
import { publishTranscriptUpdate } from "../config/sessions/session-accessor.js";
import { appendExpectedSessionTranscriptTurn } from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { SessionTranscriptContextVersion } from "../config/sessions/session-transcript-context-version.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareSessionMutationFacts } from "../gateway/session-sharing-preparation.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  prepareConversationReplyContext,
} from "./conversation-input-admission.js";
import type {
  ConversationInputAdmissionV1,
  ConversationInputScopeV1,
} from "./conversation-input.types.js";
import {
  prepareVoiceConversationPublication,
  voiceConversationAppendOptions,
} from "./voice-conversation-publication.js";
import { buildPersistedVoiceMessage } from "./voice-transcript.js";

/** The generation target is descriptive; only a fresh host admission permits publication. */
export type GreetingPublicationTarget = Readonly<{
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  storePath: string;
}>;

/** Record submitted speech once, without creating another user turn or claiming it was heard. */
export async function publishConversationGreeting(params: {
  cfg: OpenClawConfig;
  admission: ConversationInputAdmissionV1;
  scope: ConversationInputScopeV1;
  expectedTarget: GreetingPublicationTarget;
  expectedTranscript: SessionTranscriptContextVersion;
  eventId: string;
  text: string;
  timestamp: number;
  audioDelivery: "submitted" | "interrupted";
}): Promise<{ appended: boolean; audioDelivery: "submitted" | "interrupted" }> {
  const input = consumeConversationInputAdmission(params.admission, params.scope);
  let facts: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
  try {
    claimConversationInputExecution(input);
    const expected = params.expectedTarget;
    if (
      input.scope.purpose !== "greeting" ||
      input.scope.agentId !== expected.agentId ||
      input.source.sessionKey !== expected.sessionKey ||
      (params.audioDelivery !== "submitted" && params.audioDelivery !== "interrupted") ||
      !params.eventId.trim() ||
      !params.text.trim()
    ) {
      throw new Error("Greeting publication does not match its original input");
    }
    const context = await prepareConversationReplyContext(input, { text: params.text });
    const commandOwner = captureCommandOwnerAssertion(context);
    const resolveGateway = readChannelContextGatewayContextResolver(context);
    const currentConfig = () => resolveGateway?.()?.getRuntimeConfig() ?? params.cfg;
    facts = await prepareSessionMutationFacts({
      cfg: currentConfig(),
      agentId: expected.agentId,
      sessionKey: expected.sessionKey,
      preserveQualifiedAddress: true,
    });
    const source = facts;
    const assertCurrent = composeSessionSourceAssertion(
      [input.assertCurrent, commandOwner],
      (assertSource) => {
        assertSource();
        const target = source.readCurrent(currentConfig()).target;
        if (
          target.agentId !== expected.agentId ||
          target.canonicalKey !== expected.sessionKey ||
          target.storePath !== expected.storePath ||
          target.entry.sessionId !== expected.sessionId ||
          (target.entry.lifecycleRevision ?? null) !== expected.lifecycleRevision
        ) {
          throw new Error("Greeting publication target changed after generation");
        }
      },
    );
    assertCurrent();
    const { entry } = source.readCurrent(currentConfig()).target;
    const publication = prepareVoiceConversationPublication({
      agentId: expected.agentId,
      sessionKey: expected.sessionKey,
      entry,
      sourceMode: resolveAgentConversationMode(currentConfig(), expected.agentId),
      role: "assistant",
      destinationAudience: input.privateAudience,
      assertCurrent,
    });
    const target = { ...expected };
    const result = await appendExpectedSessionTranscriptTurn(target, {
      config: currentConfig(),
      keyFormat: "agent-qualified",
      expectedSessionId: expected.sessionId,
      selectedSessionId: expected.sessionId,
      selectedLifecycleRevision: expected.lifecycleRevision,
      sessionFile: expected.sessionKey,
      assertCurrent: publication?.assertCurrent ?? assertCurrent,
      messages: [
        {
          eventId: params.eventId,
          // Do not append a late greeting as an answer to a newer user turn.
          // The native writer checks this after its idempotency lookup.
          expectedTranscript: params.expectedTranscript,
          message: {
            ...buildPersistedVoiceMessage({
              role: "assistant",
              text: params.text,
              timestamp: params.timestamp,
              provider: "openclaw",
            }),
            idempotencyKey: params.eventId,
          },
          ...voiceConversationAppendOptions(publication),
        },
      ],
    });
    if (result.rejectedReason) {
      throw new Error("Greeting conversation changed before publication");
    }
    for (const appended of result.appendedMessages) {
      if (appended.appended) {
        await publishTranscriptUpdate(target, {
          message: appended.message,
          messageId: appended.messageId,
        });
      }
      if (publication && appended.anchor) {
        startConversationKnowledgePublication({
          agentId: expected.agentId,
          path: appended.anchor.storePath,
        });
      }
    }
    // Audio delivery remains an observation of the transport, not a hearing receipt.
    return {
      appended: result.appendedMessages.some((message) => message.appended),
      audioDelivery: params.audioDelivery,
    };
  } finally {
    try {
      facts?.release();
    } finally {
      input.release?.();
    }
  }
}
