import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  consultRealtimeVoiceAgent,
  prepareRealtimeVoiceAgentExecutionContext,
  type RealtimeVoiceAgentConsultResult,
} from "../talk/agent-consult-runtime.js";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceAgentConsultToolPolicy,
} from "../talk/agent-consult-tool.js";
import { controlRealtimeVoiceAgentRun } from "../talk/agent-run-control.js";
import type { RealtimeVoiceTool } from "../talk/provider-types.js";
import { readSpeechRealtimeToolAbortSignal } from "../talk/speech/provider-continuity.js";
import { prepareSpeechExpressionContext } from "../tts/expression-preparation.js";
import type {
  MeetingAgentConsultSurface,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import type {
  MeetingAgentConsultParams,
  MeetingRealtimeToolCallParams,
  MeetingRuntimePlatform,
} from "./realtime-engine.js";

export function createMeetingRealtimeEngineBindings(params: {
  platform: MeetingPlatformRuntimeMetadata;
  /** Sender identity already verified by this transport's ingress admission. */
  senderId?: string | null;
  /** Exact ingress-selected TTS scope; surface names never imply channel permission. */
  ttsContext?: { agentId?: string; channelId?: string; accountId?: string };
  config: {
    realtime: {
      agentId?: string;
      toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
      /** Explicit tools added to safe-read-only for this trusted adapter only. */
      additionalToolsAllow?: string[];
      agentThinkingLevel?: Parameters<typeof consultRealtimeVoiceAgent>[0]["thinkLevel"];
      speakCommentary?: boolean;
    };
  };
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
}): {
  platform: MeetingRuntimePlatform;
  consultAgent: (consult: MeetingAgentConsultParams) => Promise<RealtimeVoiceAgentConsultResult>;
  tools: RealtimeVoiceTool[];
  handleToolCall: (call: MeetingRealtimeToolCallParams) => Promise<void>;
} {
  const surface: MeetingAgentConsultSurface = {
    id: params.platform.id,
    provider: params.platform.id,
    lane: params.platform.id,
    ...params.platform.agentConsult,
  };
  return {
    platform: {
      displayName: params.platform.displayName,
      logScope: params.platform.logScope,
      sessionIdPrefix: params.platform.id,
    },
    consultAgent: async (consult) =>
      await consultMeetingAgent({
        surface,
        config: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        agentId: params.config.realtime.agentId,
        senderId: params.senderId,
        ttsContext: params.ttsContext,
        toolPolicy: params.config.realtime.toolPolicy,
        additionalToolsAllow: params.config.realtime.additionalToolsAllow,
        agentThinkingLevel: params.config.realtime.agentThinkingLevel,
        speakCommentary: params.config.realtime.speakCommentary,
        ...consult,
      }),
    tools: resolveRealtimeVoiceAgentConsultTools(params.config.realtime.toolPolicy),
    handleToolCall: async (call) => {
      const abortSignal = readSpeechRealtimeToolAbortSignal(call.session);
      await handleMeetingRealtimeConsultToolCall({
        surface,
        config: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        agentId: params.config.realtime.agentId,
        senderId: params.senderId,
        ttsContext: params.ttsContext,
        toolPolicy: params.config.realtime.toolPolicy,
        additionalToolsAllow: params.config.realtime.additionalToolsAllow,
        agentThinkingLevel: params.config.realtime.agentThinkingLevel,
        speakCommentary: params.config.realtime.speakCommentary,
        abortSignal,
        ...call,
      });
    },
  };
}

type MeetingAgentConsultContext = {
  surface: MeetingAgentConsultSurface;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  agentId?: string;
  senderId?: string | null;
  ttsContext?: { agentId?: string; channelId?: string; accountId?: string };
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  additionalToolsAllow?: string[];
  agentThinkingLevel?: Parameters<typeof consultRealtimeVoiceAgent>[0]["thinkLevel"];
  speakCommentary?: boolean;
};

async function consultMeetingAgent(
  params: MeetingAgentConsultContext & MeetingAgentConsultParams,
): Promise<RealtimeVoiceAgentConsultResult> {
  const agentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : resolveDefaultAgentId(params.config);
  const requesterSessionKey =
    normalizeOptionalString(params.requesterSessionKey) ?? `agent:${agentId}:main`;
  const sessionKey = `agent:${agentId}:subagent:${params.surface.id}:${params.meetingSessionId}`;
  const thinkLevel =
    params.agentThinkingLevel ??
    resolveAgentConfig(params.config, agentId)?.thinkingDefault ??
    params.config.agents?.defaults?.thinkingDefault;
  const baseToolsAllow = resolveRealtimeVoiceAgentConsultToolsAllow(params.toolPolicy);
  const toolsAllow =
    params.toolPolicy === "safe-read-only"
      ? [...new Set([...(baseToolsAllow ?? []), ...(params.additionalToolsAllow ?? [])])]
      : baseToolsAllow;
  if (params.ttsContext?.agentId && params.ttsContext.agentId !== agentId) {
    throw new Error("Speech expression scope does not match the admitted agent");
  }
  const speechExpressionContext = await prepareSpeechExpressionContext({
    cfg: params.config,
    tts: params.runtime.tts,
    agentId,
    channelId: params.ttsContext?.channelId,
    accountId: params.ttsContext?.accountId,
    target: "telephony",
    currentSourceSpeechTarget: true,
    commentaryEnabled: params.speakCommentary === true && !params.speechExpressionCaptureOnly,
    signal: params.abortSignal,
  });
  const admittedToolsAllow = params.speechExpressionCaptureOnly ? [] : toolsAllow;
  let releaseRunControl: (() => void) | undefined;
  let speechPreparation:
    | Awaited<ReturnType<PluginRuntime["tts"]["prepareTextToSpeechTelephony"]>>
    | undefined;
  try {
    speechPreparation =
      params.onSpeakableText && !speechExpressionContext
        ? await params.runtime.tts.prepareTextToSpeechTelephony({
            cfg: params.config,
            agentId,
            channelId: params.ttsContext?.channelId,
            accountId: params.ttsContext?.accountId,
            signal: params.abortSignal,
          })
        : undefined;
    if (speechPreparation && !speechPreparation.success) {
      throw new Error(speechPreparation.error ?? "Speech segmentation preparation failed");
    }
    return await consultRealtimeVoiceAgent({
      cfg: params.config,
      agentRuntime: params.runtime.agent,
      logger: params.logger,
      agentId,
      senderId: params.senderId,
      sessionKey,
      messageProvider: params.surface.provider,
      lane: params.surface.lane,
      runIdPrefix: `${params.surface.id}:${params.meetingSessionId}`,
      spawnedBy: requesterSessionKey,
      contextMode: "fork",
      args: params.args,
      transcript: params.transcript,
      surface: params.surface.surface,
      userLabel: params.surface.userLabel,
      assistantLabel: params.surface.assistantLabel,
      questionSourceLabel: params.surface.questionSourceLabel,
      thinkLevel,
      speechChannelId: params.ttsContext?.channelId,
      speakCommentary: params.speakCommentary,
      toolsAllow: admittedToolsAllow,
      speechExpressionContext,
      speechExpressionCaptureOnly: params.speechExpressionCaptureOnly,
      extraSystemPrompt: params.surface.extraSystemPrompt,
      abortSignal: params.abortSignal,
      onSpeakableText: params.onSpeakableText,
      speechSegmentationProfile:
        speechExpressionContext?.segmentationProfile ?? speechPreparation?.segmentationProfile,
      waitForPendingInput: params.waitForPendingInput,
      onRunStarted: params.onRunControl
        ? ({ runId, sessionId }) => {
            const controller = new AbortController();
            const signal = params.abortSignal
              ? AbortSignal.any([params.abortSignal, controller.signal])
              : controller.signal;
            let current = true;
            const isCurrent = (candidateSessionId?: string) =>
              current &&
              !signal.aborted &&
              (candidateSessionId === undefined || candidateSessionId === sessionId);
            const cleanup = () => {
              if (!current) {
                return;
              }
              current = false;
              signal.removeEventListener("abort", cleanup);
              params.onRunControl?.(undefined);
            };
            releaseRunControl = cleanup;
            signal.addEventListener("abort", cleanup, { once: true });
            if (signal.aborted) {
              cleanup();
              signal.throwIfAborted();
            }
            params.onRunControl?.(async (text, onQueueAccepted, options) => {
              options?.signal?.throwIfAborted();
              options?.assertCurrent?.();
              return controlRealtimeVoiceAgentRun({
                sessionKey,
                runTarget: {
                  runId,
                  signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
                  isCurrent: (candidateSessionId) => {
                    options?.assertCurrent?.();
                    return isCurrent(candidateSessionId);
                  },
                },
                // A spoken addition is not an instruction to abandon the preceding request.
                mode: options?.mode ?? "followup",
                waitForTranscriptCommit: true,
                onQueueAccepted,
                getSteeringContext: () =>
                  "The caller interrupted audio delivery. Earlier assistant output may not have been heard. " +
                  "In your next answer, consolidate still-relevant results from the preceding request with this new input. " +
                  "Respect corrections or cancellations; do not repeat completed tool actions just to repeat their results.",
                text,
                getToolAuthorityOverlay: () => {
                  if (!isCurrent(sessionId)) {
                    throw new Error("The active meeting consult is no longer current");
                  }
                  const prepared = prepareRealtimeVoiceAgentExecutionContext({
                    cfg: params.config,
                    agentRuntime: params.runtime.agent,
                    agentId,
                    senderId: params.senderId,
                    sessionKey,
                    spawnedBy: requesterSessionKey,
                    messageProvider: params.surface.provider,
                    toolsAllow: admittedToolsAllow,
                  });
                  if (!isCurrent(sessionId) || prepared.sessionEntry?.sessionId !== sessionId) {
                    throw new Error("The active meeting consult session has changed");
                  }
                  return prepared.toolAuthorityOverlay;
                },
              });
            });
            return { abortSignal: signal, cleanup };
          }
        : undefined,
    });
  } finally {
    try {
      releaseRunControl?.();
    } finally {
      try {
        await speechPreparation?.release?.();
      } finally {
        await speechExpressionContext?.release();
      }
    }
  }
}

async function handleMeetingRealtimeConsultToolCall(
  params: MeetingAgentConsultContext &
    MeetingRealtimeToolCallParams & {
      abortSignal?: AbortSignal;
    },
): Promise<void> {
  const callId = params.event.callId || params.event.itemId;
  if (params.abortSignal?.aborted) {
    return;
  }
  const submitError = async (message: string) => {
    await params.session.submitToolResult(callId, { error: message });
    if (!params.abortSignal?.aborted) {
      params.onTalkEvent({
        type: "tool.error",
        callId,
        payload: { name: params.event.name, error: message },
        final: true,
      });
    }
  };
  const unavailableToolError =
    params.strategy !== "bidi"
      ? `Tool "${params.event.name}" is only available in bidi realtime strategy`
      : params.event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME
        ? `Tool "${params.event.name}" not available`
        : undefined;
  if (unavailableToolError) {
    await submitError(unavailableToolError);
    return;
  }
  await (params.abortSignal?.aborted || !params.session.bridge.supportsToolResultContinuation
    ? undefined
    : params.session.submitToolResult(
        callId,
        buildRealtimeVoiceAgentConsultWorkingResponse(params.surface.workingResponseLabel),
        { willContinue: true },
      ));
  if (params.abortSignal?.aborted) {
    return;
  }
  params.onTalkEvent({
    type: "tool.progress",
    callId,
    payload: { name: params.event.name, status: "working" },
  });
  let result: { text: string };
  try {
    const consulted = await consultMeetingAgent({ ...params, args: params.event.args });
    // Provider tool results are text, not host-owned speech playback/admission state.
    result = { text: consulted.text };
  } catch (error) {
    if (params.abortSignal?.aborted) {
      return;
    }
    await submitError(formatErrorMessage(error));
    return;
  }
  if (params.abortSignal?.aborted) {
    return;
  }
  await params.session.submitToolResult(callId, result);
  if (params.abortSignal?.aborted) {
    return;
  }
  params.onTalkEvent({
    type: "tool.result",
    callId,
    payload: { name: params.event.name, result },
    final: true,
  });
}
