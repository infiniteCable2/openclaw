import type { RealtimeVoiceAgentConsultToolPolicy } from "../talk/agent-consult-tool.js";
/** Supported meeting SDK contracts adapt to the single transport-neutral speech owner. */
import { startSpeechRealtimeSession } from "../talk/speech/provider-session.js";
import type {
  SpeechAgentConsultParams,
  SpeechRealtimeToolCallParams,
  SpeechSessionConfig,
} from "../talk/speech/types.js";
import type { SpeechWaitingAudioConfig as MeetingWaitingAudioConfig } from "../talk/speech/waiting-audio.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";

export type {
  SpeechRuntimeSurface as MeetingRuntimePlatform,
  SpeechSessionHealth as MeetingRealtimeAudioEngineHealth,
  SpeechRealtimeSessionHandle as MeetingRealtimeAudioEngineHandle,
} from "../talk/speech/types.js";
export type MeetingRealtimeEngineConfig = {
  chrome: { audioFormat: MeetingRealtimeAudioFormat };
  realtime: {
    strategy: string;
    agentId?: string;
    provider?: string;
    transcriptionProvider?: string;
    voiceProvider?: string;
    model?: string;
    instructions?: string;
    introMessage?: string;
    responseStreaming?: "off" | "sentence";
    waitingAudio?: MeetingWaitingAudioConfig;
    video?: import("../config/zod-schema.media-frames.js").SpeechVideoConfig;
    toolPolicy?: RealtimeVoiceAgentConsultToolPolicy;
    providers: Record<string, Record<string, unknown>>;
  };
};
export type MeetingAgentConsultParams = Omit<SpeechAgentConsultParams, "sessionId"> & {
  meetingSessionId: string;
};
export type MeetingRealtimeToolCallParams = Omit<SpeechRealtimeToolCallParams, "sessionId"> & {
  meetingSessionId: string;
};

export function toSpeechSessionConfig(config: MeetingRealtimeEngineConfig): SpeechSessionConfig {
  return { audioFormat: config.chrome.audioFormat, ...config.realtime };
}

type Params = Omit<
  Parameters<typeof startSpeechRealtimeSession>[0],
  "config" | "surface" | "sessionId" | "consultAgent" | "handleToolCall"
> & {
  config: MeetingRealtimeEngineConfig;
  platform: import("../talk/speech/types.js").SpeechRuntimeSurface;
  meetingSessionId: string;
  consultAgent: (
    params: MeetingAgentConsultParams,
  ) => ReturnType<Parameters<typeof startSpeechRealtimeSession>[0]["consultAgent"]>;
  handleToolCall: (params: MeetingRealtimeToolCallParams) => Promise<void>;
};
export function startMeetingRealtimeEngine(params: Params) {
  return startSpeechRealtimeSession({
    ...params,
    config: { audioFormat: params.config.chrome.audioFormat, ...params.config.realtime },
    surface: params.platform,
    sessionId: params.meetingSessionId,
    consultAgent: ({ sessionId, ...consult }) =>
      params.consultAgent({ ...consult, meetingSessionId: sessionId }),
    handleToolCall: ({ sessionId, ...call }) =>
      params.handleToolCall({ ...call, meetingSessionId: sessionId }),
  });
}
