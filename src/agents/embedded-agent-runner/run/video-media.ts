import { normalizeMimeType } from "@openclaw/media-core/mime";
import type { ModelInputContent } from "../../../../packages/ai/src/provider-types.js";
import type { MediaToolsConfig } from "../../../config/types.tools.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { ImageContent, TextContent } from "../../../llm/types.js";
import { redactSensitiveText } from "../../../logging/redact.js";
import { resolveMediaUnderstandingScope } from "../../../media-understanding/scope.js";
import { planCommunicationMediaRoute } from "../../../media/communication-route.js";
import { isImageMediaFact, isVideoMediaFact, type MediaFact } from "../../../media/media-facts.js";
import { resolveMediaProcessingIntent } from "../../../media/media-processing.js";
import type { WebMediaResult } from "../../../media/web-media.js";
import { sanitizeImageBlocks } from "../../tool-images.js";
import { log } from "../logger.js";
import type { ImageFactIndex } from "./prompt-image-metadata.js";

export type VideoMediaOptions = {
  model: { input?: string[] };
  mediaConfig?: MediaToolsConfig;
  sessionKey?: string;
  channelId?: string;
  chatType?: string;
  maxBytes?: number;
  maxDimensionPx?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  provider?: boolean;
};
/** The existing prompt-media loader owns sandbox and attachment access. */
type VideoMediaReader = (fact: MediaFact, maxBytes: number) => Promise<WebMediaResult | null>;

export const VIDEO_OMISSION = {
  unsupported: "(video omitted: provider does not support native video)",
  unavailable: "(video omitted: source unavailable)",
  invalid: "(video omitted: invalid video MIME type)",
  limit: "(video omitted: native video byte limit exceeded)",
  suppressed: "(video omitted: automatic processing is not permitted for this attachment)",
  historical:
    "(video frames omitted: historical attachment; inspect the retained source explicitly if needed)",
  framesLimit: "(video frames omitted: request frame limit reached)",
  framesFailed: "(video frames unavailable: extraction failed; do not claim visual inspection)",
} as const;
export const VIDEO_FRAME_LABEL =
  /^\[Video attachment (\d+), frame at [\d.]+s; sampled frames do not describe the entire video\]$/;

function automaticVideoAllowed(fact: MediaFact, options: VideoMediaOptions): boolean {
  return (
    fact.hydrationSuppressed !== true &&
    resolveMediaProcessingIntent(fact).automaticUnderstanding &&
    options.mediaConfig?.video?.enabled !== false &&
    resolveMediaUnderstandingScope({
      scope: options.mediaConfig?.video?.scope,
      sessionKey: options.sessionKey,
      channel: options.channelId,
      chatType: options.chatType,
    }) !== "deny"
  );
}

async function materializeVideoFrames(
  fact: MediaFact,
  factIndex: number,
  budget: { remaining: number; framesRemaining: number },
  options: VideoMediaOptions,
  loadVideo: VideoMediaReader,
): Promise<ModelInputContent[]> {
  options.assertCurrent?.();
  if (budget.framesRemaining <= 0) {
    return [{ type: "text", text: VIDEO_OMISSION.framesLimit }];
  }
  if ((fact.sizeBytes ?? 0) > budget.remaining) {
    return [{ type: "text", text: VIDEO_OMISSION.limit }];
  }
  const loaded = await loadVideo(fact, budget.remaining);
  if (!loaded) {
    return [{ type: "text", text: VIDEO_OMISSION.unavailable }];
  }
  options.assertCurrent?.();
  if (loaded.kind !== "video" || !normalizeMimeType(loaded.contentType)?.startsWith("video/")) {
    return [{ type: "text", text: VIDEO_OMISSION.invalid }];
  }
  if (loaded.buffer.length > budget.remaining) {
    return [{ type: "text", text: VIDEO_OMISSION.limit }];
  }
  budget.remaining -= loaded.buffer.length;
  try {
    const { probeVideoBuffer, buildVideoOverviewTimestamps, extractVideoFrames } =
      await import("../../../media/video-frames.js");
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    const metadata = await probeVideoBuffer({ buffer: loaded.buffer, signal: options.signal });
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    const frames = await extractVideoFrames({
      buffer: loaded.buffer,
      timestampsSeconds: buildVideoOverviewTimestamps(
        metadata.durationSeconds,
        budget.framesRemaining,
      ),
      profile: options.mediaConfig?.video?.frames?.profile,
      maxSide: options.mediaConfig?.video?.frames?.maxSide,
      targetBytes: options.mediaConfig?.video?.frames?.targetBytes,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    budget.framesRemaining -= frames.length;
    const blocks: ModelInputContent[] = [];
    for (const frame of frames) {
      const sanitized = await sanitizeImageBlocks(
        [{ type: "image", data: frame.buffer.toString("base64"), mimeType: frame.mimeType }],
        "prompt:video-frames",
        {
          maxBytes: options.maxBytes,
          maxDimensionPx: options.maxDimensionPx,
          verifyDecodability: true,
        },
      );
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      for (const image of sanitized.images) {
        blocks.push(
          {
            type: "text",
            text: `[Video attachment ${factIndex + 1}, frame at ${frame.timestampSeconds.toFixed(3)}s; sampled frames do not describe the entire video]`,
          },
          image,
        );
      }
    }
    return blocks.length ? blocks : [{ type: "text", text: VIDEO_OMISSION.framesFailed }];
  } catch (error) {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    log.warn(`Video frame extraction failed: ${redactSensitiveText(formatErrorMessage(error))}`);
    return [{ type: "text", text: VIDEO_OMISSION.framesFailed }];
  }
}

async function materializeVideoFact(
  fact: MediaFact,
  budget: { remaining: number },
  loadVideo: VideoMediaReader,
): Promise<ModelInputContent> {
  if ((fact.sizeBytes ?? 0) > budget.remaining) {
    return { type: "text", text: VIDEO_OMISSION.limit };
  }
  const loaded = await loadVideo(fact, budget.remaining);
  if (!loaded) {
    return { type: "text", text: VIDEO_OMISSION.unavailable };
  }
  const mimeType = normalizeMimeType(loaded.contentType);
  if (loaded.kind !== "video" || !mimeType?.startsWith("video/")) {
    return { type: "text", text: VIDEO_OMISSION.invalid };
  }
  if (loaded.buffer.length > budget.remaining) {
    return { type: "text", text: VIDEO_OMISSION.limit };
  }
  budget.remaining -= loaded.buffer.length;
  return { type: "video", data: loaded.buffer.toString("base64"), mimeType };
}

export async function projectOrderedPromptMedia(params: {
  content: Array<TextContent | ImageContent>;
  media: MediaFact[];
  images: ImageContent[];
  imageFactIndexes: ImageFactIndex[];
  options: VideoMediaOptions;
  loadVideo: VideoMediaReader;
  budget: { remaining: number; framesRemaining: number };
  active: boolean;
}): Promise<{ content: ModelInputContent[]; imageFactIndexes: ImageFactIndex[] }> {
  const generatedMarkers = new Set<string>(Object.values(VIDEO_OMISSION));
  const projected: ModelInputContent[] = params.content.filter(
    (block): block is TextContent =>
      block.type === "text" &&
      !generatedMarkers.has(block.text) &&
      !VIDEO_FRAME_LABEL.test(block.text),
  );
  // Hydration already resolved image order, including inline blocks with no managed fact.
  if (!params.media.some(isVideoMediaFact)) {
    return { content: [...projected, ...params.images], imageFactIndexes: params.imageFactIndexes };
  }
  const imageFactIndexes: ImageFactIndex[] = [];
  const imagesByFact = new Map<number, ImageContent[]>();
  const factlessImages: ImageContent[] = [];
  params.images.forEach((image, index) => {
    const factIndex = params.imageFactIndexes[index];
    if (factIndex == null) {
      factlessImages.push(image);
    } else {
      imagesByFact.set(factIndex, [...(imagesByFact.get(factIndex) ?? []), image]);
    }
  });
  for (const [factIndex, fact] of params.media.entries()) {
    if (isImageMediaFact(fact)) {
      const images = imagesByFact.get(factIndex) ?? [];
      projected.push(...images);
      imageFactIndexes.push(...images.map(() => factIndex));
    } else if (isVideoMediaFact(fact)) {
      const route = planCommunicationMediaRoute({
        source: ["video"],
        target: {
          input:
            params.options.model.input?.filter(
              (kind): kind is "text" | "image" | "audio" | "video" =>
                ["text", "image", "audio", "video"].includes(kind),
            ) ?? [],
          output: ["text"],
        },
        purpose: fact.purpose,
        output: "text",
        converters: {
          stt: false,
          tts: false,
          videoFrames: params.options.mediaConfig?.video?.frames?.enabled === true,
        },
      });
      if (!automaticVideoAllowed(fact, params.options)) {
        projected.push({ type: "text", text: VIDEO_OMISSION.suppressed });
      } else if (route.kind === "ready" && !route.steps.includes("video-frames")) {
        projected.push(
          params.options.provider
            ? await materializeVideoFact(fact, params.budget, params.loadVideo)
            : { type: "text", text: VIDEO_OMISSION.unsupported },
        );
      } else if (route.kind === "ready" && route.steps.includes("video-frames")) {
        if (!params.active) {
          projected.push({ type: "text", text: VIDEO_OMISSION.historical });
          continue;
        }
        // The shared context transform may already have extracted this exact fact.
        // Reuse those transient blocks at the direct-provider handoff, not a second decode.
        const existing = imagesByFact.get(factIndex) ?? [];
        const reused = existing.slice(0, params.budget.framesRemaining);
        if (reused.length) {
          params.budget.framesRemaining -= reused.length;
        }
        const labels = params.content.filter(
          (block): block is TextContent =>
            block.type === "text" &&
            VIDEO_FRAME_LABEL.exec(block.text)?.[1] === String(factIndex + 1),
        );
        const blocks = existing.length
          ? reused.flatMap((image, index) => (labels[index] ? [labels[index], image] : [image]))
          : await materializeVideoFrames(
              fact,
              factIndex,
              params.budget,
              params.options,
              params.loadVideo,
            );
        projected.push(...blocks);
        imageFactIndexes.push(
          ...blocks.flatMap((block) => (block.type === "image" ? [factIndex] : [])),
        );
      } else {
        projected.push({ type: "text", text: VIDEO_OMISSION.unsupported });
      }
    }
  }
  projected.push(...factlessImages);
  imageFactIndexes.push(...factlessImages.map(() => null));
  return { content: projected, imageFactIndexes };
}
