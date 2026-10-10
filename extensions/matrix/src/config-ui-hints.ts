import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const matrixChannelConfigUiHints = {
  requireMentionInBotThreads: {
    label: "Mention in Bot Threads",
    help: "Require a mention in threads rooted in this bot's own Matrix events. Set false to accept unmentioned follow-ups; omit to preserve the room's existing mention behavior.",
  },
  "rooms.*.requireMentionInBotThreads": {
    label: "Mention in Bot Threads",
    help: "Override the account's bot-created thread mention policy for this Matrix room. Exact room entries replace wildcard room settings.",
  },
  "groups.*.requireMentionInBotThreads": {
    label: "Mention in Bot Threads",
    help: "Override the account's bot-created thread mention policy for this Matrix room. Exact room entries replace wildcard room settings.",
  },
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
  commentaryAgentIds: {
    label: "Matrix Commentary Agents",
    help: "Agent IDs allowed to send durable commentary updates for incoming Matrix text messages routed to them. Default: none. Does not enable reply streaming or affect voice notes and calls.",
    advanced: true,
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
  "rtc.agentProfiles": {
    label: "MatrixRTC Agent Profiles",
    help: "Optional per-agent call thinking and spoken commentary settings. A profile applies only after an exact MatrixRTC admission selects that agent; it does not grant call access. Unset thinking inherits the agent default; spoken commentary defaults off.",
    advanced: true,
  },
  "rtc.agentProfiles.*.greeting": {
    label: "MatrixRTC Agent Greeting",
    help: "Optional agent-authored opening greeting. Model text and TTS audio are prepared before joining; playback waits for the caller audio track. Preparation failure rejects the call unless onFailure is continue.",
    advanced: true,
  },
  "rtc.responseStreaming": {
    label: "MatrixRTC Speech Streaming",
    help: 'Use "sentence" to begin TTS from native visible answer blocks while the agent is still generating. Default: off.',
    advanced: true,
  },
  "rtc.waitingAudio": {
    label: "MatrixRTC Waiting Audio",
    help: "Play a trusted local mono PCM16 WAV loop after a short delay while agent work or first-segment TTS is pending.",
    advanced: true,
  },
  "rtc.waitingAudio.path": {
    label: "MatrixRTC Waiting Audio File",
    help: "Absolute path to a regular mono PCM16 WAV file that is not group- or world-writable.",
    advanced: true,
  },
  "rtc.waitingAudio.startDelayMs": {
    label: "MatrixRTC Waiting Audio Delay",
    help: "Delay in milliseconds after agent processing begins before waiting audio starts. Default: 1200.",
    advanced: true,
  },
  "rtc.waitingAudio.resumeDelayMs": {
    label: "MatrixRTC Waiting Audio Resume Delay",
    help: "Quiet time after a TTS segment before waiting audio resumes while the agent turn continues. Default: 800 ms.",
    advanced: true,
  },
  "rtc.waitingAudio.volume": {
    label: "MatrixRTC Waiting Audio Volume",
    help: "Linear waiting-audio gain from 0 through 1. Default: 0.14.",
    advanced: true,
  },
  ...createChannelConfigUiHints({ channelLabel: "Matrix", progress: {} }),
} satisfies Record<string, ChannelConfigUiHint>;
