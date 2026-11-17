import { captureCommandOwnerAssertion } from "../auto-reply/command-owner-authority.js";
import { readChannelContextGatewayContextResolver } from "../channels/message-access/admission-evidence.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import { startConversationKnowledgePublication } from "../config/sessions/conversation-publication-reconcile.js";
import { publishTranscriptUpdate } from "../config/sessions/session-accessor.js";
import { appendExpectedSessionTranscriptTurn } from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import { sessionPersonalProfileId } from "../config/sessions/session-entry-provenance.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import type { SessionTranscriptContextVersion } from "../config/sessions/session-transcript-context-version.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareSessionMutationFacts,
  type PreparedSessionSourceFacts,
  type SessionFactsRead,
} from "../gateway/session-sharing-preparation.js";
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

/** Read-only binding after connection creation; fresh admission still gates the later write. */
export type PreparedGreetingPublication = Readonly<{
  requesterProfileId: string | null;
  publication?: {
    target: GreetingPublicationTarget;
    expectedTranscript: SessionTranscriptContextVersion;
  };
}>;

/** Capture the no-overtake boundary as soon as the original connection is ready. */
export async function prepareConversationGreetingPublication(params: {
  cfg: OpenClawConfig;
  admission: ConversationInputAdmissionV1;
  scope: ConversationInputScopeV1;
  signal?: AbortSignal;
}): Promise<PreparedGreetingPublication> {
  const input = consumeConversationInputAdmission(params.admission, params.scope);
  let facts: SessionFactsRead<PreparedSessionSourceFacts> | undefined;
  try {
    claimConversationInputExecution(input);
    if (input.scope.purpose !== "greeting") {
      throw new Error("Greeting preparation requires its original host input");
    }
    const context = await prepareConversationReplyContext(input, { text: "" });
    const commandOwner = captureCommandOwnerAssertion(context);
    const resolveGateway = readChannelContextGatewayContextResolver(context);
    const currentConfig = () => resolveGateway?.()?.getRuntimeConfig() ?? params.cfg;
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      input.assertCurrent();
      commandOwner?.();
    };
    assertCurrent();
    facts = await prepareSessionMutationFacts({
      cfg: currentConfig(),
      agentId: input.scope.agentId,
      sessionKey: input.source.sessionKey,
      preserveQualifiedAddress: true,
      allowMissing: true,
    });
    assertCurrent();
    const original = facts.readCurrent(currentConfig()).target;
    const requesterProfileId = input.requesterProfile?.id ?? null;
    if (!original) {
      return { requesterProfileId };
    }
    if (original.agentId !== input.scope.agentId) {
      throw new Error("Greeting context is not the original admitted conversation target");
    }
    const target: GreetingPublicationTarget = {
      agentId: original.agentId,
      sessionKey: original.canonicalKey,
      storePath: original.storePath,
      sessionId: original.entry.sessionId,
      lifecycleRevision: original.entry.lifecycleRevision ?? null,
    };
    const personalProfileId = sessionPersonalProfileId(original.entry);
    const chatType = original.entry.chatType;
    const { contextVersion } = await readSessionTranscriptAnchorsAsync(
      target,
      { entryIds: [], includeContextVersion: true },
      params.signal,
    );
    assertCurrent();
    const current = facts.readCurrent(currentConfig()).target;
    if (
      current?.agentId !== target.agentId ||
      current.canonicalKey !== target.sessionKey ||
      current.storePath !== target.storePath ||
      current.entry.sessionId !== target.sessionId ||
      (current.entry.lifecycleRevision ?? null) !== target.lifecycleRevision ||
      sessionPersonalProfileId(current.entry) !== personalProfileId ||
      current.entry.chatType !== chatType
    ) {
      throw new Error("Greeting conversation target changed during preparation");
    }
    return {
      requesterProfileId,
      ...(contextVersion ? { publication: { target, expectedTranscript: contextVersion } } : {}),
    };
  } finally {
    try {
      facts?.release();
    } finally {
      input.release?.();
    }
  }
}

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
