import { Value } from "typebox/value";
import { z } from "zod";
import { UserChannelIdentitySchema } from "../../packages/gateway-protocol/src/schema/users.js";
import { ALL_THINKING_LEVELS } from "../auto-reply/thinking.shared.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { SpeechWaitingAudioConfig } from "../talk/speech/waiting-audio.js";
import { SpeechVideoSchema } from "./zod-schema.media-frames.js";

const TalkSpeechWaitingAudioSchema = z.strictObject({
  filePath: z.string().trim().min(1),
  startDelayMs: z.number().int().nonnegative(),
  resumeDelayMs: z.number().int().nonnegative().optional(),
  volume: z.number().min(0).max(1),
}) satisfies z.ZodType<SpeechWaitingAudioConfig>;

const TalkSpeechScopeKeySchema = z
  .string()
  .min(1)
  .refine((id) => id === id.trim() && !isBlockedObjectKey(id));

function rejectBlockedScopeKeys<T>(value: T, ctx: z.RefinementCtx): T {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (isBlockedObjectKey(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Speech override keys must not contain blocked object keys",
        });
        return z.NEVER;
      }
    }
  }
  return value;
}

const TalkSpeechProviderOverridesSchema = z.record(
  TalkSpeechScopeKeySchema,
  z.strictObject({
    thinking: z.enum(ALL_THINKING_LEVELS).optional(),
    fastMode: z.boolean().optional(),
  }),
);

const TalkSpeechChannelOverridesSchema = z.record(
  TalkSpeechScopeKeySchema,
  z.strictObject({
    providers: z.preprocess(
      (value: z.input<typeof TalkSpeechProviderOverridesSchema>, ctx) =>
        rejectBlockedScopeKeys(value, ctx),
      TalkSpeechProviderOverridesSchema,
    ),
  }),
);

const TalkSpeechAgentOverridesSchema = z.strictObject({
  channels: z.preprocess(
    (value: z.input<typeof TalkSpeechChannelOverridesSchema>, ctx) =>
      rejectBlockedScopeKeys(value, ctx),
    TalkSpeechChannelOverridesSchema,
  ),
});

const TalkSpeechSourceIdentitySchema = z
  .strictObject({ channelId: z.string(), accountId: z.string(), senderId: z.string() })
  .refine((source) => Value.Check(UserChannelIdentitySchema, source), {
    message: "Speech source must be an exact native channel identity",
  });

// Native timers accept signed 32-bit millisecond delays. The harness also
// clamps each wait because queued PCM adds its own playback duration.
const TalkSpeechEchoSuppressionTailSchema = z
  .number()
  .min(0)
  .max(2_147_483_647 / 1_000);

const TalkSpeechSourceOverridesSchema = z
  .array(
    z.strictObject({
      source: TalkSpeechSourceIdentitySchema,
      echoSuppressionTailSeconds: TalkSpeechEchoSuppressionTailSchema,
    }),
  )
  .superRefine((overrides, ctx) => {
    const seen = new Set<string>();
    for (const [index, { source }] of overrides.entries()) {
      const key = JSON.stringify([source.channelId, source.accountId, source.senderId]);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "source"],
          message: "Speech source overrides must have distinct exact channel identities",
        });
      }
      seen.add(key);
    }
  });

const TalkSpeechAgentProfileSchema = z
  .strictObject({
    responseStreaming: z.enum(["off", "sentence"]).optional(),
    speakCommentary: z.boolean().optional(),
    echoSuppressionTailSeconds: TalkSpeechEchoSuppressionTailSchema.optional(),
    sourceOverrides: TalkSpeechSourceOverridesSchema.optional(),
    video: SpeechVideoSchema.optional(),
    agentOverrides: TalkSpeechAgentOverridesSchema.optional(),
    expression: z
      .strictObject({
        channels: z.record(
          z
            .string()
            .min(1)
            .refine((id) => id === id.trim() && !isBlockedObjectKey(id)),
          z.strictObject({
            targets: z.array(z.enum(["audio-file", "voice-note", "telephony"])).max(3),
          }),
        ),
      })
      .optional(),
    waitingAudio: TalkSpeechWaitingAudioSchema.optional(),
    greeting: z
      .strictObject({
        enabled: z.boolean().optional(),
        prompt: z.string().trim().min(1).optional(),
        timeZone: z.string().trim().min(1).optional(),
        timeoutMs: z.number().int().positive().optional(),
        onFailure: z.enum(["reject", "continue"]).optional(),
      })
      .optional(),
  })
  .superRefine((profile, ctx) => {
    if (profile.speakCommentary === true && profile.responseStreaming !== "sentence") {
      ctx.addIssue({
        code: "custom",
        path: ["speakCommentary"],
        message: 'Spoken commentary requires responseStreaming="sentence"',
      });
    }
  });

const TalkSpeechAgentProfilesSchema = z.record(
  z
    .string()
    .min(1)
    .refine(
      (id) => id === id.trim() && !isBlockedObjectKey(id),
      "Speech profile keys must be exact agent IDs without surrounding whitespace or reserved object keys",
    ),
  TalkSpeechAgentProfileSchema,
);

export const TalkSpeechSchema = z.strictObject({
  agentProfiles: z.preprocess((value: z.input<typeof TalkSpeechAgentProfilesSchema>, ctx) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const key of Object.getOwnPropertyNames(value)) {
        if (!isBlockedObjectKey(key)) {
          continue;
        }
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "Speech profile keys must not contain blocked object keys",
        });
        return z.NEVER;
      }
    }
    return value;
  }, TalkSpeechAgentProfilesSchema),
});
