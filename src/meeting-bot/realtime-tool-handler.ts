import { formatErrorMessage } from "../infra/errors.js";
import type { RealtimeVoiceAgentConsultResult } from "../talk/agent-consult-runtime.js";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
} from "../talk/agent-consult-tool.js";
import type { MeetingRealtimeToolCallParams } from "./realtime-engine.js";

/** Provider protocol continuation; session/input authority belongs to the supplied native owner. */
export async function handleMeetingConsultToolCall(
  params: MeetingRealtimeToolCallParams & {
    abortSignal?: AbortSignal;
    workingResponseLabel: string;
    consultAgent(args: unknown): Promise<RealtimeVoiceAgentConsultResult>;
  },
): Promise<void> {
  const callId = params.event.callId || params.event.itemId;
  if (params.abortSignal?.aborted) return;
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
  if (params.strategy !== "bidi" || params.event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
    await submitError(`Tool "${params.event.name}" is not available for this realtime strategy`);
    return;
  }
  if (params.session.bridge.supportsToolResultContinuation) {
    await params.session.submitToolResult(
      callId,
      buildRealtimeVoiceAgentConsultWorkingResponse(params.workingResponseLabel),
      { willContinue: true },
    );
  }
  if (params.abortSignal?.aborted) return;
  params.onTalkEvent({
    type: "tool.progress",
    callId,
    payload: { name: params.event.name, status: "working" },
  });
  let text: string;
  try {
    text = (await params.consultAgent(params.event.args)).text;
  } catch (error) {
    if (!params.abortSignal?.aborted) await submitError(formatErrorMessage(error));
    return;
  }
  if (params.abortSignal?.aborted) return;
  const result = { text };
  await params.session.submitToolResult(callId, result);
  if (!params.abortSignal?.aborted) {
    params.onTalkEvent({
      type: "tool.result",
      callId,
      payload: { name: params.event.name, result },
      final: true,
    });
  }
}
