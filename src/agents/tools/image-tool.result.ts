import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentToolResult } from "../runtime/index.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { buildMediaReferenceDetails } from "./media-tool-shared.js";

/** Shared native sanitization and private image result for image/frame inspection. */
export async function buildNativeImageToolResult(
  loadedImages: readonly {
    buffer: Buffer;
    mimeType: string;
    resolvedInput: string;
    rewrittenFrom?: string;
  }[],
  config?: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const content = await sanitizeContentBlocksImages(
    loadedImages.map((image) => ({
      type: "image" as const,
      data: image.buffer.toString("base64"),
      mimeType: image.mimeType,
    })),
    "image:native",
    { ...resolveImageSanitizationLimits(config), verifyDecodability: true },
  );
  // Sanitization replaces rejected image blocks with text at the same position.
  const retainedImages = loadedImages.filter((_, index) => content[index]?.type === "image");
  const result: AgentToolResult<unknown> = {
    content: [
      {
        type: "text",
        text: `Loaded ${retainedImages.length} image${retainedImages.length === 1 ? "" : "s"} into private model context for inspection; not displayed, attached, or sent to the user.`,
      },
      ...content,
    ],
    details: {
      transport: "native",
      ...buildMediaReferenceDetails(retainedImages, "image", { includeEmpty: true }),
      media: { outbound: false },
    },
  };

  return result;
}
