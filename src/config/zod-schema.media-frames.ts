import { z } from "zod";

/** The same rendition contract serves file extraction and live communication frames. */
export const VideoFrameRenditionSchema = z.strictObject({
  profile: z.enum(["preview", "detail", "source"]).optional(),
  maxSide: z.number().int().min(64).max(8192).optional(),
  targetBytes: z
    .number()
    .int()
    .min(4096)
    .max(16 * 1024 * 1024)
    .optional(),
});

export const VideoFrameExtractionSchema = VideoFrameRenditionSchema.extend({
  enabled: z.boolean().optional(),
  maxFrames: z.number().int().min(1).max(12).optional(),
});

export const SpeechVideoSchema = z.strictObject({
  enabled: z.boolean(),
  intervalMs: z.number().int().min(250).max(60_000).optional(),
  maxSourceDimension: z.number().int().min(64).max(4096).optional(),
  maxSourceBytes: z
    .number()
    .int()
    .min(4096)
    .max(32 * 1024 * 1024)
    .optional(),
  retentionMs: z
    .number()
    .int()
    .min(1000)
    .max(15 * 60_000)
    .optional(),
  selectedRetentionMs: z
    .number()
    .int()
    .min(1000)
    .max(15 * 60_000)
    .optional(),
  maxBufferBytes: z
    .number()
    .int()
    .min(4096)
    .max(256 * 1024 * 1024)
    .optional(),
  maxFramesPerTurn: z.number().int().min(1).max(6).optional(),
  preview: VideoFrameRenditionSchema.optional(),
});

export type VideoFrameExtractionConfig = z.infer<typeof VideoFrameExtractionSchema>;
export type SpeechVideoConfig = z.infer<typeof SpeechVideoSchema>;
