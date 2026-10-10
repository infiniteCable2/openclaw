import { z } from "zod";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { SpeechWaitingAudioConfig } from "../talk/speech/waiting-audio.js";

const TalkSpeechWaitingAudioSchema = z.strictObject({
  filePath: z.string().trim().min(1),
  startDelayMs: z.number().int().nonnegative(),
  resumeDelayMs: z.number().int().nonnegative().optional(),
  volume: z.number().min(0).max(1),
}) satisfies z.ZodType<SpeechWaitingAudioConfig>;

export const TalkSpeechAgentProfileSchema = z
  .strictObject({
    responseStreaming: z.enum(["off", "sentence"]).optional(),
    speakCommentary: z.boolean().optional(),
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

export const TalkSpeechSchema = z.strictObject({
  agentProfiles: z.record(
    z
      .string()
      .min(1)
      .refine(
        (id) => id === id.trim() && !isBlockedObjectKey(id),
        "Speech profile keys must be exact agent IDs without surrounding whitespace or reserved object keys",
      ),
    TalkSpeechAgentProfileSchema,
  ),
});
