import type { TalkSpeechAgentProfileConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SpeechWaitingAudioConfig } from "./waiting-audio.js";

export type ResolvedTalkSpeechAgentProfile = {
  responseStreaming: "off" | "sentence";
  speakCommentary: boolean;
  waitingAudio?: SpeechWaitingAudioConfig;
  greeting?: {
    enabled: true;
    prompt: string;
    timeZone?: string;
    timeoutMs: number;
    onFailure: "reject" | "continue";
  };
};

/** Presentation policy only: admission has already selected and authorized this exact agent. */
export function resolveTalkSpeechAgentProfile(
  config: Pick<OpenClawConfig, "talk">,
  admittedAgentId: string,
): ResolvedTalkSpeechAgentProfile {
  const profiles = config.talk?.speech?.agentProfiles;
  const profile: TalkSpeechAgentProfileConfig | undefined =
    profiles && Object.hasOwn(profiles, admittedAgentId) ? profiles[admittedAgentId] : undefined;
  const greeting = profile?.greeting;
  return {
    responseStreaming: profile?.responseStreaming ?? "sentence",
    speakCommentary: profile?.speakCommentary ?? false,
    ...(profile?.waitingAudio ? { waitingAudio: profile.waitingAudio } : {}),
    ...(greeting?.enabled === true
      ? {
          greeting: {
            enabled: true as const,
            prompt:
              greeting.prompt ??
              "Give the caller a short personal greeting appropriate to the time of day.",
            ...(greeting.timeZone ? { timeZone: greeting.timeZone } : {}),
            timeoutMs: greeting.timeoutMs ?? 30_000,
            onFailure: greeting.onFailure ?? "reject",
          },
        }
      : {}),
  };
}
