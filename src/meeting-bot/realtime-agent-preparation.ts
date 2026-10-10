/** Supported readiness facade; leases are owned by the common speech preparation. */
import { prepareSpeechSession } from "../talk/speech/preparation.js";
import { toSpeechSessionConfig, type MeetingRealtimeEngineConfig } from "./realtime-engine.js";
export type { SpeechSessionPreparation as MeetingAgentRealtimePreparation } from "../talk/speech/preparation.js";

export function prepareMeetingAgentRealtimeEngine(
  params: Omit<Parameters<typeof prepareSpeechSession>[0], "config"> & {
    config: MeetingRealtimeEngineConfig;
  },
) {
  return prepareSpeechSession({ ...params, config: toSpeechSessionConfig(params.config) });
}
