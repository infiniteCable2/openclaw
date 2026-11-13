import { randomUUID } from "node:crypto";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { buildApiErrorObservationFields } from "../agents/embedded-agent-error-observation.js";
import { hasDeliberateSilentTerminalReply } from "../agents/embedded-agent-runner/result-fallback-classifier.js";
import { runEmbeddedAgent } from "../agents/embedded-agent-runner/run.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { captureCommandOwnerAssertion } from "../auto-reply/command-owner-authority.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { prepareChannelRunAdmission } from "../auto-reply/reply/channel-run-admission.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { isSilentReplyText } from "../auto-reply/tokens.js";
import { normalizeChatType } from "../channels/chat-type.js";
import {
  readChannelContextAdmissionEvidence,
  readChannelContextGatewayContextResolver,
} from "../channels/message-access/admission-evidence.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import { sessionPersonalProfileId } from "../config/sessions/session-entry-provenance.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareSessionMutationFacts } from "../gateway/session-sharing-preparation.js";
import { formatErrorMessage } from "../infra/errors.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { isSessionPersonalBootstrapTurn } from "../sessions/session-participant-input.js";
import type { RealtimeVoiceAgentConsultResult } from "./agent-consult-runtime.js";
import { createRealtimeVoiceConsultSpeechDelivery } from "./agent-consult-speech-delivery.js";
import type { ConsumedConversationInput } from "./conversation-input-admission.js";
import type { ConversationReplyParams } from "./conversation-reply.js";

/** Generate an unplayed greeting in one native detached run, never a durable user turn. */
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
  let admission: ReturnType<typeof prepareChannelRunAdmission> | undefined;
  const startedAt = performance.now();
  let phase = "greeting-authority";
  let executionPhase: string | undefined;
  let failureReported = false;
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
    const chatType = normalizeChatType(params.context.ChatType) ?? original?.entry.chatType;
    const bootstrapUserProfileId = isSessionPersonalBootstrapTurn(params.context)
      ? sessionPersonalProfileId(original?.entry)
      : undefined;
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
    // A greeting needs persona and current caller facts, never a conversation
    // snapshot or memory retrieval. Keep native run admission and bootstrap.
    const sessionManager = SessionManager.inMemory(workspaceDir);
    assertTargetCurrent();
    const assertSpeechCurrent = () => {
      assertTargetCurrent();
      params.speech.speechExpressionContext?.assertCurrent();
    };
    const signal = params.signal ?? new AbortController().signal;
    const delivery = createRealtimeVoiceConsultSpeechDelivery({
      ...params.speech,
      // Preparation is capture-only; it must not acquire a live output receipt.
      onSpeakableText: undefined,
      runId,
      sessionId: identity.sessionId,
      abortSignal: signal,
      speechExpressionCaptureOnly: true,
      speakCommentary: false,
      fallbackText: "",
      assertExpressionCurrent: assertSpeechCurrent,
      assertNotInterrupted: assertTargetCurrent,
    });
    admission = prepareChannelRunAdmission({
      cfg: params.cfg,
      sourceContext: params.context,
      runId,
      agentId,
      ingressKind: "channel",
      boundary: "talk.conversation-greeting",
      evidence: readChannelContextAdmissionEvidence(params.context),
      operatorAuthority: input.operatorAuthority,
      assertSourceCurrent: assertTargetCurrent,
      onAdmitted(context) {
        bindGatewayContextResolver(context, resolveGateway);
      },
    });
    phase = "greeting-generation";
    const result = await runEmbeddedAgent({
      ...identity,
      sessionFile: identity.sessionKey,
      sessionTarget: { agentId, storePath: facts.storageTarget.storePath, ...identity },
      sessionManager,
      sessionPersistence: "detached",
      cleanupBundleMcpOnRunEnd: true,
      preparedRunAdmission: admission,
      config: params.cfg,
      agentId,
      chatType,
      bootstrapUserProfileId,
      workspaceDir,
      agentDir: resolveAgentDir(params.cfg, agentId),
      sandboxSessionKey: input.source.sessionKey,
      prompt: params.text,
      extraSystemPrompt: [
        params.speech.guidance,
        params.speech.speechExpressionContext?.guidance,
        input.requesterProfile?.displayName
          ? `Confirmed caller name (data): ${JSON.stringify(input.requesterProfile.displayName)}.`
          : undefined,
        "Prepare one short greeting only. It has not been played or delivered. Do not perform tasks or use tools.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      disableTools: true,
      toolsAllow: [],
      disableTrajectory: true,
      modelRequestProfile: params.speech.modelRequestProfile,
      nativeSpeechPresentation: params.speech.speechExpressionContext
        ? { assertCurrent: assertSpeechCurrent }
        : undefined,
      currentSourceReplyTarget: delivery.currentSourceReplyTarget,
      verboseLevel: "off",
      reasoningLevel: "off",
      timeoutMs: resolveAgentTimeoutMs({ cfg: params.cfg }),
      runId,
      abortSignal: signal,
      onBlockReply: delivery.onBlockReply,
      onExecutionPhase: (info) => {
        executionPhase = info.phase;
      },
    });
    assertTargetCurrent();
    const providerError = result.payloads
      ?.map(getReplyPayloadMetadata)
      .find((metadata) => metadata?.terminalProviderError === true);
    if (result.meta?.aborted || result.meta?.error || providerError) {
      const observed = buildApiErrorObservationFields(
        providerError?.providerFailure?.rawError ?? result.meta?.error?.message,
      );
      // Keep native failure facts without exposing provider previews or generated text.
      const failure = {
        runId,
        phase: "greeting-generation",
        kind: result.meta?.error?.kind ?? (result.meta?.aborted ? "aborted" : "provider_error"),
        reason: providerError?.providerFailure?.reason,
        rawErrorHash: observed.rawErrorHash,
        rawErrorFingerprint: observed.rawErrorFingerprint,
        httpCode: observed.httpCode,
        providerRuntimeFailureKind: observed.providerRuntimeFailureKind,
        executionPhase,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
      params.speech.logger.warn("[talk] native greeting generation failed", failure);
      failureReported = true;
      throw new Error("Native greeting generation did not complete", { cause: failure });
    }
    phase = "greeting-finalization";
    const greeting = await delivery.finish({
      yielded: false,
      deliberateSilent: hasDeliberateSilentTerminalReply(result),
      payloads: result.payloads ?? [],
    });
    assertSpeechCurrent();
    if (!greeting.text.trim() || isSilentReplyText(greeting.text)) {
      throw new Error("Native greeting generation produced no greeting");
    }
    return {
      ...greeting,
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
    if (!failureReported) {
      const { rawErrorHash, rawErrorFingerprint, httpCode, providerRuntimeFailureKind } =
        buildApiErrorObservationFields(formatErrorMessage(error));
      params.speech.logger.warn("[talk] native greeting preparation failed", {
        phase,
        executionPhase,
        elapsedMs: Math.round(performance.now() - startedAt),
        rawErrorHash,
        rawErrorFingerprint,
        httpCode,
        providerRuntimeFailureKind,
      });
    }
    throw error;
  } finally {
    try {
      admission?.close();
    } finally {
      releaseSource?.();
    }
  }
}
