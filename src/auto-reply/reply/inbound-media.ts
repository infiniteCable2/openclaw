/** Detects inbound media and audio facts in channel message context. */
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { isMeaningfulMediaFact, normalizeMediaFacts } from "../../media/media-facts.js";
import { resolveMediaProcessingIntent } from "../../media/media-processing.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";

/** Minimal inbound media fields used by media/audio detection. */
type InboundMediaContext = Pick<MsgContext, "media"> & {
  Body?: unknown;
  StickerMediaIncluded?: unknown;
  SkipStickerMediaUnderstanding?: unknown;
  Sticker?: unknown;
};

function meaningfulMedia(ctx: InboundMediaContext) {
  return normalizeMediaFacts(ctx.media).filter(isMeaningfulMediaFact);
}

/** Returns true when the context carries current-turn media or sticker data. */
export function hasInboundMedia(ctx: InboundMediaContext): boolean {
  return Boolean(ctx.StickerMediaIncluded || ctx.Sticker || meaningfulMedia(ctx).length > 0);
}

/** Returns true when current-turn media still needs automatic understanding. */
export function hasInboundMediaForUnderstanding(ctx: InboundMediaContext): boolean {
  const media = meaningfulMedia(ctx);
  if (!ctx.SkipStickerMediaUnderstanding) {
    return Boolean(
      media.some((fact) => resolveMediaProcessingIntent(fact).automaticUnderstanding) ||
      (media.length === 0 && (ctx.StickerMediaIncluded || ctx.Sticker)),
    );
  }
  return media.slice(1).some((fact) => resolveMediaProcessingIntent(fact).automaticUnderstanding);
}

/** Returns true when the current turn carries structured audio media facts. */
export function hasInboundAudio(ctx: InboundMediaContext): boolean {
  const isAudio = (type: string | undefined) =>
    type === "audio" || type?.startsWith("audio/") === true;
  return normalizeMediaFacts(ctx.media).some(
    (media) => media.kind === "audio" || isAudio(normalizeMimeType(media.contentType)),
  );
}

/**
 * Returns true for conversational voice messages. Channels that can distinguish voice messages
 * from ordinary audio files must set `voiceMessage`; unmarked audio remains compatible with older
 * channel adapters until they provide that proof.
 */
export function hasInboundVoiceMessage(ctx: InboundMediaContext): boolean {
  const audio = normalizeMediaFacts(ctx.media).filter((media) => {
    const type = normalizeMimeType(media.contentType);
    return media.kind === "audio" || type === "audio" || type?.startsWith("audio/") === true;
  });
  return audio.some((media) => resolveMediaProcessingIntent(media).voiceReply);
}
