import { randomUUID } from "node:crypto";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { runEmbeddedAgent } from "../agents/embedded-agent-runner/run.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { captureCommandOwnerAssertion } from "../auto-reply/command-owner-authority.js";
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
import { withSessionContextAdmission } from "../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareSessionMutationFacts } from "../gateway/session-sharing-preparation.js";
import {
  delegateMemoryAudience,
  resolveMemoryAudienceFromEntry,
  type MemoryAudienceGrant,
} from "../plugins/memory-audience.js";
import { resolveLoadedMemoryProviderKind } from "../plugins/memory-state.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { isSessionPersonalBootstrapTurn } from "../sessions/session-participant-input.js";
import type { RealtimeVoiceAgentConsultResult } from "./agent-consult-runtime.js";
import { createRealtimeVoiceConsultSpeechDelivery } from "./agent-consult-speech-delivery.js";
import type { ConsumedConversationInput } from "./conversation-input-admission.js";
import type { ConversationReplyParams } from "./conversation-reply.js";

// A ringing call needs recent conversational cues, not a second full model
// context. Keep the detached greeting small even when its source has a long
// history or large media entries; the actual conversation keeps its full context.
const GREETING_CONTEXT_MAX_BYTES = 32 * 1024;
const GREETING_CONTEXT_MAX_EVENTS = 16;

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
  const source = await prepareSessionMutationFacts({
    cfg: currentConfig(),
    agentId,
    sessionKey: input.source.sessionKey,
    preserveQualifiedAddress: true,
    allowMissing: true,
  });
  let admission: ReturnType<typeof prepareChannelRunAdmission> | undefined;
  let sourceAudience: MemoryAudienceGrant | undefined;
  let delegatedAudience: MemoryAudienceGrant | undefined;
  try {
    assertCurrent();
    const original = source.readCurrent(currentConfig()).target;
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
      const current = source.readCurrent(currentConfig()).target;
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
    if (original && resolveLoadedMemoryProviderKind(params.cfg) === "native") {
      const resolution = await resolveMemoryAudienceFromEntry(
        {
          agentId,
          sessionKey: original.canonicalKey,
          sessionId: original.entry.sessionId,
          senderIsOwner: Boolean(assertCommandOwner),
          storePath: original.storePath,
          assertCallerCurrent: assertTargetCurrent,
        },
        original.entry,
      );
      if (resolution.status === "granted") {
        sourceAudience = resolution;
      }
      assertTargetCurrent();
      if (resolution.status === "granted") {
        delegatedAudience = await delegateMemoryAudience(resolution.audience, {
          sessionKey: identity.sessionKey,
          storePath: original.storePath,
          detached: true,
          assertCallerCurrent: assertTargetCurrent,
        });
        assertTargetCurrent();
      }
    }
    let truncated = false;
    const originalTarget = original && {
      agentId,
      sessionId: original.entry.sessionId,
      sessionKey: original.canonicalKey,
      storePath: original.storePath,
    };
    if (originalTarget) {
      await waitForSessionTranscriptProjection(originalTarget, params.signal);
      assertTargetCurrent();
    }
    const sessionManager = originalTarget
      ? await withSessionContextAdmission(originalTarget, undefined, () =>
          SessionManager.openDetachedBoundedAsync(originalTarget, {
            signal: params.signal,
            cwd: workspaceDir,
            maxBytes: GREETING_CONTEXT_MAX_BYTES,
            maxEvents: GREETING_CONTEXT_MAX_EVENTS,
            onTruncated: () => {
              truncated = true;
            },
          }),
        )
      : SessionManager.inMemory(workspaceDir);
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
    const result = await runEmbeddedAgent({
      ...identity,
      sessionFile: identity.sessionKey,
      sessionTarget: { agentId, storePath: source.storageTarget.storePath, ...identity },
      sessionManager,
      sessionPersistence: "detached",
      memoryAudience: delegatedAudience?.audience,
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
        truncated ? "Only a bounded native conversation snapshot is available." : undefined,
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
    });
    assertTargetCurrent();
    if (result.meta?.aborted || result.meta?.error) {
      throw new Error("Native greeting generation did not complete");
    }
    const greeting = await delivery.finish({ yielded: false, payloads: result.payloads ?? [] });
    assertSpeechCurrent();
    if (!greeting.text.trim() || isSilentReplyText(greeting.text)) {
      throw new Error("Native greeting generation produced no greeting");
    }
    return greeting;
  } finally {
    try {
      admission?.close();
    } finally {
      try {
        delegatedAudience?.release();
      } finally {
        try {
          sourceAudience?.release();
        } finally {
          source.release();
        }
      }
    }
  }
}
