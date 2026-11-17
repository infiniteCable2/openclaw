import { randomUUID } from "node:crypto";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { buildApiErrorObservationFields } from "../agents/embedded-agent-error-observation.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import { runIsolatedCompletion } from "../agents/isolated-completion.js";
import { resolveSimpleCompletionSelectionForAgent } from "../agents/simple-completion-selection.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { captureCommandOwnerAssertion } from "../auto-reply/command-owner-authority.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { isSilentReplyText } from "../auto-reply/tokens.js";
import { readChannelContextGatewayContextResolver } from "../channels/message-access/admission-evidence.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import { sessionPersonalProfileId } from "../config/sessions/session-entry-provenance.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareSessionMutationFacts } from "../gateway/session-sharing-preparation.js";
import { formatErrorMessage } from "../infra/errors.js";
import { parseSpeechPresentation } from "../tts/speech-presentation.js";
import type { RealtimeVoiceAgentConsultResult } from "./agent-consult-runtime.js";
import type { ConsumedConversationInput } from "./conversation-input-admission.js";
import type { ConversationReplyParams } from "./conversation-reply.js";

/** Generate an unplayed greeting with native prompt-only inference, never a user turn. */
export async function prepareConversationGreeting(params: {
  input: ConsumedConversationInput;
  context: MsgContext;
  cfg: OpenClawConfig;
  text: string;
  speech: ConversationReplyParams["speech"];
  signal?: AbortSignal;
}): Promise<RealtimeVoiceAgentConsultResult> {
  const { input } = params;
  const assertCommandOwner = captureCommandOwnerAssertion(params.context);
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    input.assertCurrent();
    assertCommandOwner?.();
  };
  assertCurrent();
  const agentId = input.scope.agentId;
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  const runId = `conversation-greeting-${randomUUID()}`;
  const identity = resolveInternalSessionEffectsIdentity({ agentId, runId });
  const resolveGateway = readChannelContextGatewayContextResolver(params.context);
  const currentConfig = () => resolveGateway?.()?.getRuntimeConfig() ?? params.cfg;
  // This is exactly the admitted conversation target, not its parent/root/history donor.
  // The existing owner retains its lifecycle facts; equality of an agent/key is not a read grant.
  let releaseSource: (() => void) | undefined;
  const startedAt = performance.now();
  let phase = "greeting-authority";
  try {
    const facts = await prepareSessionMutationFacts({
      cfg: currentConfig(),
      agentId,
      sessionKey: input.source.sessionKey,
      preserveQualifiedAddress: true,
      allowMissing: true,
    });
    releaseSource = facts.release;
    assertCurrent();
    const original = facts.readCurrent(currentConfig()).target;
    const originalIdentity = original && {
      agentId: original.agentId,
      canonicalKey: original.canonicalKey,
      storePath: original.storePath,
      sessionId: original.entry.sessionId,
      lifecycleRevision: original.entry.lifecycleRevision,
      personalProfileId: sessionPersonalProfileId(original.entry),
      chatType: original.entry.chatType,
    };
    const assertTargetCurrent = () => {
      assertCurrent();
      const current = facts.readCurrent(currentConfig()).target;
      if (
        current?.agentId !== originalIdentity?.agentId ||
        current?.canonicalKey !== originalIdentity?.canonicalKey ||
        current?.storePath !== originalIdentity?.storePath ||
        current?.entry.sessionId !== originalIdentity?.sessionId ||
        current?.entry.lifecycleRevision !== originalIdentity?.lifecycleRevision ||
        sessionPersonalProfileId(current?.entry) !== originalIdentity?.personalProfileId ||
        current?.entry.chatType !== originalIdentity?.chatType
      ) {
        throw new Error("Greeting conversation target changed during preparation");
      }
    };
    if (original && original.agentId !== agentId) {
      throw new Error("Greeting context is not the original admitted conversation target");
    }
    const expectedTranscript = original
      ? (
          await readSessionTranscriptAnchorsAsync(
            {
              agentId,
              sessionKey: original.canonicalKey,
              sessionId: original.entry.sessionId,
              storePath: original.storePath,
            },
            { entryIds: [], includeContextVersion: true },
            params.signal,
          )
        ).contextVersion
      : undefined;
    assertTargetCurrent();
    const assertSpeechCurrent = () => {
      assertTargetCurrent();
      params.speech.speechExpressionContext?.assertCurrent();
    };
    const selection = resolveSimpleCompletionSelectionForAgent({
      cfg: params.cfg,
      agentId,
    });
    if (!selection) {
      throw new Error("No greeting model configured for the admitted agent");
    }
    const language = resolveAgentIdentity(params.cfg, agentId)?.language;
    phase = "greeting-generation";
    // Input admission already owns caller/command authority. The isolated owner
    // checks that authority and the selected model at dispatch, without agent
    // bootstrap, hooks, conversation hydration, tools, or source delivery.
    const result = await runIsolatedCompletion({
      ...identity,
      config: params.cfg,
      agentId,
      provider: selection.provider,
      model: selection.modelId,
      authProfileId: selection.profileId,
      workspaceDir,
      agentDir: selection.agentDir,
      operatorAuthority: input.operatorAuthority,
      assertCurrent: assertSpeechCurrent,
      prompt: params.text,
      systemPrompt: [
        "Prepare one short spoken greeting only. It has not been played or delivered. Do not perform tasks or use tools.",
        language ? `Default greeting language (data): ${JSON.stringify(language)}.` : undefined,
        params.speech.speechExpressionContext?.guidance,
        input.requesterProfile?.displayName
          ? `Confirmed caller name (data): ${JSON.stringify(input.requesterProfile.displayName)}.`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
      thinkLevel: "off",
      answerTokenBudget: 256,
      outputTextPolicy: "strict-visible",
      timeoutMs: resolveAgentTimeoutMs({ cfg: params.cfg }),
      abortSignal: params.signal,
    });
    assertSpeechCurrent();
    phase = "greeting-finalization";
    const greeting = parseSpeechPresentation(result.text, {
      expressionEnabled: Boolean(params.speech.speechExpressionContext),
    });
    if (!greeting.text.trim() || isSilentReplyText(greeting.text)) {
      throw new Error("Native greeting generation produced no greeting");
    }
    return {
      text: greeting.text,
      utterances: [
        {
          text: greeting.text,
          speech: greeting.speech,
          localServiceAdmission: params.speech.speechExpressionContext?.localServiceAdmission,
          expectedSpeechSelection: params.speech.speechExpressionContext?.expectedSpeechSelection,
        },
      ],
      ...(originalIdentity && expectedTranscript
        ? {
            greeting: {
              target: {
                agentId,
                sessionKey: originalIdentity.canonicalKey,
                sessionId: originalIdentity.sessionId,
                lifecycleRevision: originalIdentity.lifecycleRevision ?? null,
                storePath: originalIdentity.storePath,
              },
              eventId: `talk-greeting:${input.scope.conversationId}:${input.scope.inputId}`,
              timestamp: input.participant?.promptedAt ?? Date.now(),
              expectedTranscript,
            },
          }
        : {}),
    };
  } catch (error) {
    const { rawErrorHash, rawErrorFingerprint, httpCode, providerRuntimeFailureKind } =
      buildApiErrorObservationFields(formatErrorMessage(error));
    params.speech.logger.warn("[talk] native greeting preparation failed", {
      runId,
      phase,
      elapsedMs: Math.round(performance.now() - startedAt),
      rawErrorHash,
      rawErrorFingerprint,
      httpCode,
      providerRuntimeFailureKind,
    });
    throw error;
  } finally {
    releaseSource?.();
  }
}
