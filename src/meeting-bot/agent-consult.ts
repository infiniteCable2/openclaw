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
import type { RealtimeVoiceTool, RealtimeVoiceToolCallEvent } from "../talk/provider-types.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import type { TalkEventInput } from "../talk/talk-events.js";
import type {
  MeetingAgentConsultSurface,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import type {
  MeetingAgentConsultParams,
  MeetingRealtimeToolCallParams,
  MeetingRuntimePlatform,
} from "./realtime-engine.js";
import { readMeetingRealtimeToolAbortSignal } from "./realtime-tool-continuity.js";

function resolveMeetingRealtimeTools(
  policy: RealtimeVoiceAgentConsultToolPolicy,
): RealtimeVoiceTool[] {
  return resolveRealtimeVoiceAgentConsultTools(policy);
}

function resolveMeetingAgentConsultSurface(
  platform: MeetingPlatformRuntimeMetadata,
): MeetingAgentConsultSurface {
  return {
    id: platform.id,
    provider: platform.id,
    lane: platform.id,
    ...platform.agentConsult,
  };
}

export function createMeetingRealtimeEngineBindings(params: {
  platform: MeetingPlatformRuntimeMetadata;
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
  const surface = resolveMeetingAgentConsultSurface(params.platform);
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
        toolPolicy: params.config.realtime.toolPolicy,
        additionalToolsAllow: params.config.realtime.additionalToolsAllow,
        agentThinkingLevel: params.config.realtime.agentThinkingLevel,
        speakCommentary: params.config.realtime.speakCommentary,
        ...consult,
      }),
    tools: resolveMeetingRealtimeTools(params.config.realtime.toolPolicy),
    handleToolCall: async (call) => {
      const abortSignal = readMeetingRealtimeToolAbortSignal(call.session);
      await handleMeetingRealtimeConsultToolCall({
        surface,
        config: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        agentId: params.config.realtime.agentId,
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

async function submitMeetingConsultWorkingResponse(params: {
  session: RealtimeVoiceBridgeSession;
  abortSignal?: AbortSignal;
  callId: string;
  label: string;
}): Promise<void> {
  if (params.abortSignal?.aborted || !params.session.bridge.supportsToolResultContinuation) {
    return;
  }
  await params.session.submitToolResult(
    params.callId,
    buildRealtimeVoiceAgentConsultWorkingResponse(params.label),
    { willContinue: true },
  );
}

async function consultMeetingAgent(params: {
  surface: MeetingAgentConsultSurface;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  agentId?: string;
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  additionalToolsAllow?: string[];
  agentThinkingLevel?: Parameters<typeof consultRealtimeVoiceAgent>[0]["thinkLevel"];
  speakCommentary?: boolean;
  meetingSessionId: string;
  requesterSessionKey?: string;
  args: unknown;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  abortSignal?: AbortSignal;
  onSpeakableText?: MeetingAgentConsultParams["onSpeakableText"];
  onRunControl?: MeetingAgentConsultParams["onRunControl"];
  waitForPendingInput?: MeetingAgentConsultParams["waitForPendingInput"];
}): Promise<RealtimeVoiceAgentConsultResult> {
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
  let releaseRunControl: (() => void) | undefined;
  try {
    return await consultRealtimeVoiceAgent({
      cfg: params.config,
      agentRuntime: params.runtime.agent,
      logger: params.logger,
      agentId,
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
      speakCommentary: params.speakCommentary,
      toolsAllow,
      extraSystemPrompt: params.surface.extraSystemPrompt,
      abortSignal: params.abortSignal,
      onSpeakableText: params.onSpeakableText,
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
            params.onRunControl?.((text, onQueueAccepted) =>
              controlRealtimeVoiceAgentRun({
                sessionKey,
                runTarget: { runId, signal, isCurrent },
                // A spoken addition is not an instruction to abandon the preceding request.
                mode: "followup",
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
                    sessionKey,
                    spawnedBy: requesterSessionKey,
                    messageProvider: params.surface.provider,
                    toolsAllow,
                  });
                  if (!isCurrent(sessionId) || prepared.sessionEntry?.sessionId !== sessionId) {
                    throw new Error("The active meeting consult session has changed");
                  }
                  return prepared.toolAuthorityOverlay;
                },
              }),
            );
            return { abortSignal: signal, cleanup };
          }
        : undefined,
    });
  } finally {
    releaseRunControl?.();
  }
}

async function handleMeetingRealtimeConsultToolCall(params: {
  surface: MeetingAgentConsultSurface;
  strategy: string;
  session: RealtimeVoiceBridgeSession;
  event: RealtimeVoiceToolCallEvent;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  agentId?: string;
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  additionalToolsAllow?: string[];
  agentThinkingLevel?: Parameters<typeof consultRealtimeVoiceAgent>[0]["thinkLevel"];
  speakCommentary?: boolean;
  meetingSessionId: string;
  requesterSessionKey?: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  abortSignal?: AbortSignal;
  onTalkEvent?: (event: TalkEventInput) => void;
}): Promise<void> {
  const callId = params.event.callId || params.event.itemId;
  if (params.abortSignal?.aborted) {
    return;
  }
  if (params.strategy !== "bidi") {
    const error = `Tool "${params.event.name}" is only available in bidi realtime strategy`;
    await params.session.submitToolResult(callId, { error });
    if (params.abortSignal?.aborted) {
      return;
    }
    params.onTalkEvent?.({
      type: "tool.error",
      callId,
      payload: { name: params.event.name, error },
      final: true,
    });
    return;
  }
  if (params.event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
    const error = `Tool "${params.event.name}" not available`;
    await params.session.submitToolResult(callId, { error });
    if (params.abortSignal?.aborted) {
      return;
    }
    params.onTalkEvent?.({
      type: "tool.error",
      callId,
      payload: { name: params.event.name, error },
      final: true,
    });
    return;
  }
  await submitMeetingConsultWorkingResponse({
    session: params.session,
    abortSignal: params.abortSignal,
    callId,
    label: params.surface.workingResponseLabel,
  });
  if (params.abortSignal?.aborted) {
    return;
  }
  params.onTalkEvent?.({
    type: "tool.progress",
    callId,
    payload: { name: params.event.name, status: "working" },
  });
  let result: { text: string };
  try {
    result = await consultMeetingAgent({
      surface: params.surface,
      config: params.config,
      runtime: params.runtime,
      logger: params.logger,
      agentId: params.agentId,
      toolPolicy: params.toolPolicy,
      additionalToolsAllow: params.additionalToolsAllow,
      agentThinkingLevel: params.agentThinkingLevel,
      speakCommentary: params.speakCommentary,
      meetingSessionId: params.meetingSessionId,
      requesterSessionKey: params.requesterSessionKey,
      args: params.event.args,
      transcript: params.transcript,
      abortSignal: params.abortSignal,
    });
  } catch (error) {
    if (params.abortSignal?.aborted) {
      return;
    }
    const message = formatErrorMessage(error);
    await params.session.submitToolResult(callId, { error: message });
    if (params.abortSignal?.aborted) {
      return;
    }
    params.onTalkEvent?.({
      type: "tool.error",
      callId,
      payload: { name: params.event.name, error: message },
      final: true,
    });
    return;
  }
  if (params.abortSignal?.aborted) {
    return;
  }
  await params.session.submitToolResult(callId, result);
  if (params.abortSignal?.aborted) {
    return;
  }
  params.onTalkEvent?.({
    type: "tool.result",
    callId,
    payload: { name: params.event.name, result },
    final: true,
  });
}
