import {
  createMeetingRealtimeEngineBindingsV2,
  type MeetingRealtimeBindingsV2Params,
} from "openclaw/plugin-sdk/meeting-runtime";
import { resolveAgentSpeechConversationRoute } from "openclaw/plugin-sdk/routing";
import { createMatrixRtcConversationInputSource } from "./rtc-ingress.js";

const MATRIX_RTC_PLATFORM = {
  id: "matrix-rtc",
  displayName: "MatrixRTC",
  logScope: "matrix rtc",
  agentConsult: {
    surface: "matrix-rtc",
    userLabel: "caller",
    assistantLabel: "assistant",
    questionSourceLabel: "live Matrix audio call",
    workingResponseLabel: "caller",
    extraSystemPrompt:
      "You are speaking in a live Matrix audio call. Match the caller's language and keep spoken replies concise and natural.",
  },
  session: { idPrefix: "matrix-rtc", participantIdentity: (transport: string) => transport },
} as const;

/** Keep call routing, its original host input and its published output on one binding. */
export function createMatrixRtcConversationBindings(params: {
  source: Omit<Parameters<typeof createMatrixRtcConversationInputSource>[0], "dispatchSessionKey">;
  cfg: MeetingRealtimeBindingsV2Params["fullConfig"];
  realtime: MeetingRealtimeBindingsV2Params["config"]["realtime"];
  logger: MeetingRealtimeBindingsV2Params["logger"];
  videoEnabled: boolean;
}) {
  const { source } = params;
  const conversation = resolveAgentSpeechConversationRoute({
    cfg: params.cfg,
    agentId: source.agentId,
    channel: "matrix",
    accountId: source.accountId,
    sourceSessionKey: source.sourceSessionKey,
    conversationId: source.conversationId,
  });
  const inputSource = createMatrixRtcConversationInputSource({
    ...source,
    dispatchSessionKey: conversation.sessionKey,
  });
  const bindings = createMeetingRealtimeEngineBindingsV2({
    platform: MATRIX_RTC_PLATFORM,
    inputSource,
    agentId: source.agentId,
    conversationId: source.conversationId,
    assertOutputCurrent: source.assertCurrent,
    connectionPresentation: {
      kind: "call",
      channel: "matrix",
      label: "Matrix audio call",
      readTarget: { agentId: source.agentId, sessionKey: conversation.sessionKey },
      input: { audio: true, video: params.videoEnabled },
      output: { audio: true },
      operations: ["current-turn-reply", "cancel-output"],
      assertCurrent: source.assertCurrent,
    },
    senderId: source.remoteMembership.userId,
    ttsContext: { agentId: source.agentId, channelId: "matrix", accountId: source.accountId },
    config: { realtime: params.realtime },
    fullConfig: params.cfg,
    runtime: source.runtime,
    logger: params.logger,
  });
  return { conversation, bindings };
}
