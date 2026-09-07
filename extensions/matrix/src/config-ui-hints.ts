import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
// Matrix helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const matrixChannelConfigUiHints = {
  joinIntro: {
    label: "Matrix Group Join Introduction",
    help: "Post one brief introduction when the bot joins an allowed group room (default: true). Account settings override the channel-wide setting.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "Matrix",
    mentionPatterns: {
      targetDescription: "Matrix room IDs",
      policyNote:
        "Native Matrix mention evidence still triggers even when regex patterns are denied.",
      denyNote: "Native mention evidence still triggers.",
    },
  }),
  allowBots: {
    label: "Matrix Allow Bot Messages",
    help: 'Allow messages from other configured Matrix bot accounts to trigger replies (default: false). Set "mentions" to require a visible room mention.',
  },
  botLoopProtection: {
    label: "Matrix Bot Loop Protection",
    help: "Sliding-window guard for accepted Matrix configured-bot loops. Default is enabled whenever allowBots lets configured bot messages reach dispatch.",
  },
  "botLoopProtection.enabled": {
    label: "Matrix Bot Loop Protection Enabled",
    help: 'Enable the bot-pair loop guard. Defaults to true when allowBots is true or "mentions", and false when configured bot messages are ignored.',
  },
  "botLoopProtection.maxEventsPerWindow": {
    label: "Matrix Bot Loop Events per Window",
    help: "Maximum accepted bot-pair messages within the sliding window before suppression starts. Default: 20.",
  },
  "botLoopProtection.windowSeconds": {
    label: "Matrix Bot Loop Window Seconds",
    help: "Sliding window length for counting bot-pair messages. Default: 60.",
  },
  "botLoopProtection.cooldownSeconds": {
    label: "Matrix Bot Loop Cooldown Seconds",
    help: "How long to suppress the bot pair after it exceeds the budget. Default: 60.",
  },
  dangerouslyAllowNameMatching: {
    label: "Matrix Display Name Matching",
    help: "Compatibility opt-in for resolving Matrix display names and joined room names in allowlists. Prefer full @user:server IDs and room IDs or aliases because names are mutable.",
  },
  rtc: {
    label: "MatrixRTC Audio Calls",
    help: "Opt-in, fail-closed MatrixRTC audio calls. Each accepted call must match an exact room, user, and normal OpenClaw agent route.",
  },
  "rtc.authServiceUrl": {
    label: "MatrixRTC Authorization URL",
    help: "Pinned HTTPS authorization-service URL. It must match the LiveKit transport advertised by the homeserver.",
  },
  "rtc.mediaBridgeCommand": {
    label: "MatrixRTC Media Bridge",
    help: "Absolute path to the separately installed native LiveKit PCM/E2EE bridge.",
  },
  "rtc.transcriptionProvider": {
    label: "MatrixRTC Transcription Provider",
    help: "Registered realtime transcription provider used for inbound call audio.",
  },
  "rtc.toolPolicy": {
    label: "MatrixRTC Tool Policy",
    help: "Tool access for the configured agent during calls. Owner mode still requires an exact admitted identity and route.",
    advanced: true,
  },
  "rtc.responseStreaming": {
    label: "MatrixRTC Speech Streaming",
    help: 'Use "sentence" to begin TTS from sanitized final-answer sentence blocks while the agent is still generating. Default: off.',
    advanced: true,
  },
  ...createChannelConfigUiHints({ channelLabel: "Matrix", progress: {} }),
} satisfies Record<string, ChannelConfigUiHint>;
