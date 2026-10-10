/** Supported greeting facade; synthesis and readiness stay in the common speech owner. */
import { prepareSpeechGreeting } from "../talk/speech/greeting.js";
export type { PreparedSpeechGreeting as PreparedMeetingAgentGreeting } from "../talk/speech/greeting.js";

type Params = Omit<Parameters<typeof prepareSpeechGreeting>[0], "sessionId" | "consultAgent"> & {
  meetingSessionId: string;
  consultAgent: (
    params: Omit<
      Parameters<Parameters<typeof prepareSpeechGreeting>[0]["consultAgent"]>[0],
      "sessionId"
    > & { meetingSessionId: string },
  ) => ReturnType<Parameters<typeof prepareSpeechGreeting>[0]["consultAgent"]>;
};
export function prepareMeetingAgentGreeting(params: Params) {
  return prepareSpeechGreeting({
    ...params,
    sessionId: params.meetingSessionId,
    consultAgent: ({ sessionId, ...consult }) =>
      params.consultAgent({ ...consult, meetingSessionId: sessionId }),
  });
}
