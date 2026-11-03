import type { TalkSpeechAgentProfileConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UserChannelIdentity } from "../../state/user-profiles.types.js";
import type { SpeechWaitingAudioConfig } from "./waiting-audio.js";

export type ResolvedTalkSpeechAgentProfile = {
  responseStreaming: "off" | "sentence";
  speakCommentary: boolean;
  echoSuppressionTailSeconds: number;
  video?: import("../../config/zod-schema.media-frames.js").SpeechVideoConfig;
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
  verifiedSource?: Readonly<UserChannelIdentity>,
): ResolvedTalkSpeechAgentProfile {
  const profiles = config.talk?.speech?.agentProfiles;
  const profile: TalkSpeechAgentProfileConfig | undefined =
    profiles && Object.hasOwn(profiles, admittedAgentId) ? profiles[admittedAgentId] : undefined;
  const greeting = profile?.greeting;
  const sourceOverride = verifiedSource
    ? profile?.sourceOverrides?.find(
        ({ source }) =>
          source.channelId === verifiedSource.channelId &&
          source.accountId === verifiedSource.accountId &&
          source.senderId === verifiedSource.senderId,
      )
    : undefined;
  return {
    responseStreaming: profile?.responseStreaming ?? "sentence",
    speakCommentary: profile?.speakCommentary ?? false,
    echoSuppressionTailSeconds:
      sourceOverride?.echoSuppressionTailSeconds ?? profile?.echoSuppressionTailSeconds ?? 3,
    ...(profile?.video?.enabled === true ? { video: profile.video } : {}),
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
