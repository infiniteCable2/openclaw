/** Supported meeting SDK adapter; the shared speech owner contains all processing. */
import { startSpeechSession } from "../talk/speech/session.js";
import {
  toSpeechSessionConfig,
  type MeetingAgentConsultParams,
  type MeetingRealtimeEngineConfig,
  type MeetingRealtimeAudioEngineHandle,
  type MeetingRuntimePlatform,
} from "./realtime-engine.js";
export {
  prepareMeetingAgentRealtimeEngine,
  type MeetingAgentRealtimePreparation,
} from "./realtime-agent-preparation.js";

type Params = Omit<
  Parameters<typeof startSpeechSession>[0],
  "config" | "surface" | "sessionId" | "consultAgent" | "onSession"
> & {
  config: MeetingRealtimeEngineConfig;
  platform: MeetingRuntimePlatform;
  meetingSessionId: string;
  onSession?: (session: MeetingRealtimeAudioEngineHandle) => void;
  consultAgent: (
    params: MeetingAgentConsultParams,
  ) => ReturnType<Parameters<typeof startSpeechSession>[0]["consultAgent"]>;
};
export function startMeetingAgentRealtimeEngine(
  params: Params,
): Promise<MeetingRealtimeAudioEngineHandle> {
  return startSpeechSession({
    ...params,
    config: toSpeechSessionConfig(params.config),
    surface: params.platform,
    sessionId: params.meetingSessionId,
    consultAgent: ({ sessionId, ...consult }) =>
      params.consultAgent({ ...consult, meetingSessionId: sessionId }),
  });
}
