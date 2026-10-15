import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { buildInboundMediaNoteProjection } from "../../auto-reply/media-note.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ImageContent } from "../../llm/types.js";
import { prepareFileContextFromMedia } from "../../media-understanding/file-context.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import {
  isImageMediaFact,
  isVideoMediaFact,
  readPersistedMediaFacts,
} from "../../media/media-facts.js";
import {
  detectAndLoadPromptImages,
  materializePromptVideoFrames,
} from "../embedded-agent-runner/run/images.js";
import {
  readPersistedImageBlockFactIndexes,
  readPersistedMediaImageLayout,
} from "../embedded-agent-runner/run/prompt-image-metadata.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import { sanitizeImageBlocks } from "../tool-images.js";

/** Restores model input without changing the canonical source row or invoking channel delivery. */
export async function prepareHarnessContextMedia(params: {
  message: AgentMessage;
  maxChars: number;
  config?: OpenClawConfig;
  workspaceDir: string;
  agentWorkspaceDir?: string;
  modelInput: string[];
  agentId?: string;
  channelId?: string;
  sessionKey?: string;
  chatType?: string;
  accountId?: string;
  sandbox?: { root: string; bridge: SandboxFsBridge };
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<{ text?: string; images: ImageContent[] }> {
  params.assertCurrent();
  if (params.message.role !== "user" || params.maxChars <= 0) {
    return { images: [] };
  }
  if (!Number.isFinite(params.maxChars)) {
    throw new Error("Context media requires a finite character budget");
  }
  const message = params.message;
  const media = readPersistedMediaFacts(message) ?? [];
  const inlineImages = Array.isArray(message.content)
    ? message.content.flatMap((part) => (part.type === "image" ? [part] : []))
    : [];
  if (!media.length && !inlineImages.length) {
    return { images: [] };
  }
  const files = await prepareFileContextFromMedia({
    media,
    config: params.config ?? {},
    workspaceDir: params.workspaceDir,
    channelId: params.channelId,
    accountId: params.accountId,
    maxChars: params.maxChars,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  const imageFacts = media.filter(isImageMediaFact);
  const hasImageAttachments = imageFacts.length > 0 || inlineImages.length > 0;
  const text = [files.text];
  if (hasImageAttachments) {
    text.push(buildInboundMediaNoteProjection({ media: imageFacts }).text ?? "[Image attachment]");
  }
  if (!params.modelInput.includes("image")) {
    if (hasImageAttachments || files.images.length) {
      text.push("[Attachment images omitted: this model does not support image input]");
    }
    return { text: text.filter(Boolean).join("\n\n"), images: [] };
  }
  const limits = { ...resolveImageSanitizationLimits(params.config), maxBytes: MAX_IMAGE_BYTES };
  const workspaceOnly = resolveEffectiveToolFsWorkspaceOnly({
    cfg: params.config,
    agentId: params.agentId,
  });
  const inlineFactIndexes = readPersistedImageBlockFactIndexes(message);
  const rawImages = await detectAndLoadPromptImages({
    prompt: "",
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    model: { input: params.modelInput },
    media,
    mediaImageLayout: readPersistedMediaImageLayout(message),
    existingImages: inlineImages,
    existingImageFactIndexes: inlineFactIndexes,
    workspaceOnly,
    localRoots: workspaceOnly
      ? undefined
      : getAgentScopedMediaLocalRoots(params.config ?? {}, params.agentId, params.workspaceDir),
    sandbox: params.sandbox,
    ...limits,
  });
  params.assertCurrent();
  // Previously hydrated video images belong to the frame converter below. Keep
  // their source ownership rather than appending them and decoding the same fact again.
  const entries = rawImages.images.flatMap((image, index) => {
    const factIndex = rawImages.imageFactIndexes[index];
    const fact = factIndex == null ? undefined : media[factIndex];
    return fact && isVideoMediaFact(fact)
      ? []
      : [{ image, sourceIndex: factIndex ?? media.length + index }];
  });
  const videoFrames = await materializePromptVideoFrames({
    media,
    existingContent: Array.isArray(message.content) ? message.content : undefined,
    existingImages: rawImages.images,
    existingImageFactIndexes: rawImages.imageFactIndexes,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    model: { input: params.modelInput },
    mediaConfig: params.config?.tools?.media,
    assertCurrent: params.assertCurrent,
    signal: params.signal,
    sessionKey: params.sessionKey,
    channelId: params.channelId,
    chatType: params.chatType,
    workspaceOnly,
    localRoots: workspaceOnly
      ? undefined
      : getAgentScopedMediaLocalRoots(params.config ?? {}, params.agentId, params.workspaceDir),
    sandbox: params.sandbox,
    ...limits,
  });
  params.assertCurrent();
  text.push(...videoFrames.content.flatMap((block) => (block.type === "text" ? [block.text] : [])));
  let videoImageIndex = 0;
  for (const block of videoFrames.content) {
    if (block.type === "image") {
      entries.push({
        image: block,
        sourceIndex: videoFrames.imageFactIndexes[videoImageIndex++] ?? media.length,
      });
    }
  }
  // The loader counts failed media facts; inline-only blocks have no fact to
  // charge, so include their sanitation drops in the visible disposition too.
  const unownedInlineCount = inlineImages.filter(
    (_, index) => inlineFactIndexes?.[index] == null,
  ).length;
  const retainedUnownedCount = rawImages.imageFactIndexes.filter((index) => index === null).length;
  let failedImages =
    rawImages.failedMediaCount + Math.max(0, unownedInlineCount - retainedUnownedCount);
  for (const page of files.images) {
    params.assertCurrent();
    const sanitized = await sanitizeImageBlocks([page], "context:file", limits);
    params.assertCurrent();
    failedImages += sanitized.dropped;
    for (const image of sanitized.images) {
      entries.push({ image, sourceIndex: page.attachmentIndex });
    }
  }
  // A historical reload failure does not invalidate an earlier image answer.
  if (failedImages) {
    text.push(
      `[${failedImages} referenced image${failedImages === 1 ? "" : "s"} not included in this context]`,
    );
  }
  if (hasImageAttachments && !rawImages.images.length && !rawImages.failedMediaCount) {
    text.push("[Referenced image contents are not included in this context]");
  }
  return {
    text: text.filter(Boolean).join("\n\n"),
    images: entries
      // Stable sorting retains page order within each attachment.
      .toSorted((left, right) => left.sourceIndex - right.sourceIndex)
      .map(({ image }) => image),
  };
}
