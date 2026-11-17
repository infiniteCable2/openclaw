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
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
    params.speech.speechExpressionContext?.assertCurrent();
  };
  assertCurrent();
  const agentId = input.scope.agentId;
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  const runId = `conversation-greeting-${randomUUID()}`;
  const identity = resolveInternalSessionEffectsIdentity({ agentId, runId });
  const greetingPreparation = {
    eventId: `talk-greeting:${input.scope.conversationId}:${input.scope.inputId}`,
    timestamp: input.participant?.promptedAt ?? Date.now(),
    requesterProfileId: input.requesterProfile?.id ?? null,
  };
  const startedAt = performance.now();
  let phase = "greeting-generation";
  try {
    const selection = resolveSimpleCompletionSelectionForAgent({
      cfg: params.cfg,
      agentId,
    });
    if (!selection) {
      throw new Error("No greeting model configured for the admitted agent");
    }
    const language = resolveAgentIdentity(params.cfg, agentId)?.language;
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
      assertCurrent,
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
    assertCurrent();
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
      greetingPreparation,
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
  }
}
