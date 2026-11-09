import {
  AllowFromListSchema,
  ChannelBotLoopProtectionSchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelStreamingPreviewSchema,
  ChannelStreamingProgressSchema,
  buildChannelConfigSchema,
  buildGroupEntrySchema,
  buildNestedDmConfigSchema,
  ContextVisibilityModeSchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  MentionPatternsPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const matrixChannelConfigUiHints = {
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
  ...createChannelConfigUiHints({ channelLabel: "Matrix", progress: {} }),
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
} satisfies Record<string, ChannelConfigUiHint>;

const matrixActionSchema = z
  .object({
    reactions: z.boolean().optional(),
    messages: z.boolean().optional(),
    pins: z.boolean().optional(),
    profile: z.boolean().optional(),
    memberInfo: z.boolean().optional(),
    channelInfo: z.boolean().optional(),
    verification: z.boolean().optional(),
  })
  .optional();

const matrixThreadBindingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    idleHours: z.number().nonnegative().optional(),
    maxAgeHours: z.number().nonnegative().optional(),
    spawnSessions: z.boolean().optional(),
    defaultSpawnContext: z.enum(["isolated", "fork"]).optional(),
  })
  .optional();

const matrixExecApprovalsSchema = z
  .object({
    enabled: z.union([z.boolean(), z.literal("auto")]).optional(),
    approvers: AllowFromListSchema,
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    target: z.enum(["dm", "channel", "both"]).optional(),
  })
  .optional();

export const matrixRoomSchema = buildGroupEntrySchema({
  requireMentionInBotThreads: z.boolean().optional(),
  account: z.string().optional(),
  allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
  botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
  autoReply: z.boolean().optional(),
  users: AllowFromListSchema,
})
  .omit({ toolsBySender: true, allowFrom: true })
  .strict()
  .optional();

const matrixNetworkSchema = z
  .object({
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

const matrixRtcSchema = z
  .object({
    enabled: z.boolean().optional(),
    authServiceUrl: z.string().url().optional(),
    mediaBridgeCommand: z.string().min(1).optional(),
    transcriptionProvider: z.string().min(1).optional(),
    providers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    toolPolicy: z.enum(["safe-read-only", "owner", "none"]).optional(),
    agentProfiles: z
      .record(
        z.string().min(1),
        z
          .object({
            agentThinkingLevel: z
              .enum([
                "off",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "adaptive",
                "max",
                "ultra",
              ])
              .optional(),
            speakCommentary: z.boolean().optional(),
            greeting: z
              .object({
                enabled: z.boolean(),
                prompt: z.string().max(2_000).optional(),
                timeZone: z.string().min(1).optional(),
                timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
                onFailure: z.enum(["continue", "reject"]).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .optional(),
    responseStreaming: z.enum(["off", "sentence"]).optional(),
    waitingAudio: z
      .object({
        path: z.string().min(1),
        startDelayMs: z.number().int().min(0).max(30_000).optional(),
        resumeDelayMs: z.number().int().min(0).max(30_000).optional(),
        volume: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    admissions: z
      .array(
        z
          .object({
            roomId: z.string().min(1),
            userId: z.string().min(1),
            agentId: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .optional();

export const matrixStreamingSchema = z
  .object({
    mode: z.enum(["partial", "quiet", "progress", "off"]).optional(),
    ...ChannelDeliveryStreamingConfigSchema.shape,
    progress: ChannelStreamingProgressSchema.omit({ commentary: true, narration: true }).optional(),
    preview: ChannelStreamingPreviewSchema.pick({ toolProgress: true }).optional(),
  })
  .strict();

const retiredMatrixAccountStreamingKeys = [
  "streamMode",
  "chunkMode",
  "blockStreaming",
  "blockStreamingCoalesce",
  "draftChunk",
] as const;

function hasCanonicalMatrixAccountStreaming(account: unknown): boolean {
  if (typeof account !== "object" || account === null || Array.isArray(account)) {
    return true;
  }
  if (retiredMatrixAccountStreamingKeys.some((key) => Object.hasOwn(account, key))) {
    return false;
  }
  if (!Object.hasOwn(account, "streaming")) {
    return true;
  }
  const streaming = (account as { streaming?: unknown }).streaming;
  return typeof streaming === "object" && streaming !== null && !Array.isArray(streaming);
}

export const MatrixConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  configWrites: z.boolean().optional(),
  joinIntro: z.boolean().optional(),
  defaultAccount: z.string().optional(),
  // Accounts stay schema-open for most fields, but credential leaves must use
  // SecretInput so Control UI redaction keeps source/provider and only masks id.
  accounts: z
    .record(
      z.string(),
      z
        .object({
          joinIntro: z.boolean().optional(),
          requireMentionInBotThreads: z.boolean().optional(),
          accessToken: buildSecretInputSchema().optional(),
          password: buildSecretInputSchema().optional(),
          rtc: matrixRtcSchema,
        })
        .passthrough()
        .refine(hasCanonicalMatrixAccountStreaming, {
          message:
            'flat or scalar streaming values are no longer supported; use streaming.* and run "openclaw doctor --fix"',
        }),
    )
    .optional(),
  markdown: MarkdownConfigSchema,
  homeserver: z.string().optional(),
  network: matrixNetworkSchema,
  proxy: z.string().optional(),
  userId: z.string().optional(),
  accessToken: buildSecretInputSchema().optional(),
  password: buildSecretInputSchema().optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  avatarUrl: z.string().optional(),
  initialSyncLimit: z.number().optional(),
  encryption: z.boolean().optional(),
  allowlistOnly: z.boolean().optional(),
  dangerouslyAllowNameMatching: z.boolean().optional(),
  allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
  botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
  groupPolicy: GroupPolicySchema.optional(),
  requireMentionInBotThreads: z.boolean().optional(),
  mentionPatterns: MentionPatternsPolicySchema.optional(),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  streaming: matrixStreamingSchema.optional(),
  commentaryAgentIds: z.array(z.string().min(1)).optional(),
  replyToMode: z.enum(["off", "first", "all", "batched"]).optional(),
  threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  textChunkLimit: z.number().optional(),
  responsePrefix: z.string().optional(),
  ackReaction: z.string().optional(),
  ackReactionScope: z
    .enum(["group-mentions", "group-all", "direct", "all", "none", "off"])
    .optional(),
  reactionNotifications: z.enum(["off", "own"]).optional(),
  threadBindings: matrixThreadBindingsSchema,
  startupVerification: z.enum(["off", "if-unverified"]).optional(),
  startupVerificationCooldownHours: z.number().optional(),
  mediaMaxMb: z.number().optional(),
  historyLimit: z.number().int().min(0).optional(),
  autoJoin: z.enum(["always", "allowlist", "off"]).optional(),
  autoJoinAllowlist: AllowFromListSchema,
  groupAllowFrom: AllowFromListSchema,
  dm: buildNestedDmConfigSchema({
    sessionScope: z.enum(["per-user", "per-room"]).optional(),
    threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  }),
  execApprovals: matrixExecApprovalsSchema,
  rtc: matrixRtcSchema,
  groups: z.object({}).catchall(matrixRoomSchema).optional(),
  rooms: z.object({}).catchall(matrixRoomSchema).optional(),
  actions: matrixActionSchema,
});

export const MatrixChannelConfigSchema = buildChannelConfigSchema(MatrixConfigSchema, {
  uiHints: matrixChannelConfigUiHints,
});
