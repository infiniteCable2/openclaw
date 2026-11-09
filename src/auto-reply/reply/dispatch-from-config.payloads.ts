import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveUserMessages } from "../../shared/user-messages.js";
import { shouldAttemptTtsPayload } from "../../tts/tts-config.js";
import type { PreparedTtsPreferences } from "../../tts/tts-preferences.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  type ReplyPayload,
} from "../reply-payload.js";
import { prepareReplyPayloadForDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

const ttsRuntimeLoader = createLazyImportLoader(() => import("../../tts/tts.runtime.js"));

export function buildNoVisibleReplyFallbackText(runId?: string, language?: string): string {
  const messages = resolveUserMessages(language);
  const reference = normalizeOptionalString(runId);
  // Caller-supplied IDs must not inject markup, mentions, or unbounded text into a channel.
  return reference && /^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(reference)
    ? `${messages.replyNoVisible} ${messages.replyReference(reference)}`
    : messages.replyNoVisible;
}

export const QUEUE_CAP_REJECTION_TEXT = resolveUserMessages().replyQueueFull;

export const COLLABORATIVE_STEERING_DISABLED_TEXT =
  "Someone else’s turn is still running, and collaborative steering is disabled. Your message wasn’t queued. Resend it as /followup <message> to run it afterward.\n\nAdmins can enable collaborative steering with messages.queue.allowCollaborativeSteering: true.";

type SourceReplySuppressionState = {
  ctx: { InboundEventKind?: InboundEventKind };
  explicitCommandTurnCtx: boolean;
  suppressAutomaticSourceDelivery: boolean;
  sendPolicyDenied: boolean;
};

export function shouldDeliverDespiteSourceReplySuppression(
  payload: ReplyPayload,
  state: SourceReplySuppressionState,
): boolean {
  return (
    state.suppressAutomaticSourceDelivery &&
    !state.sendPolicyDenied &&
    getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true &&
    (state.ctx.InboundEventKind !== "room_event" || state.explicitCommandTurnCtx)
  );
}

export function hasExecApprovalPayload(payload: ReplyPayload): boolean {
  return isRecord(payload.channelData?.execApproval);
}

export async function shouldSuppressMessageToolOnlyErrorProgress(
  payload: ReplyPayload,
  state: {
    sourceReplyDeliveryMode?: string;
    shouldEmitFullVerboseProgressAsync: () => Promise<boolean>;
  },
): Promise<boolean> {
  if (
    state.sourceReplyDeliveryMode !== "message_tool_only" ||
    (await state.shouldEmitFullVerboseProgressAsync()) ||
    payload.isError !== true
  ) {
    return false;
  }
  const reply = resolveSendableOutboundReplyParts(payload);
  return !reply.hasMedia && !hasExecApprovalPayload(payload);
}

export function hasExecApprovalUnavailablePayload(payload: ReplyPayload): boolean {
  return isRecord(payload.channelData?.execApprovalUnavailable);
}

export function hasAskUserPayload(payload: ReplyPayload): boolean {
  return isRecord(payload.channelData?.askUser);
}

export function requiresDurableToolResultDelivery(payload: ReplyPayload): boolean {
  return (
    resolveSendableOutboundReplyParts(payload).hasMedia ||
    hasExecApprovalPayload(payload) ||
    hasExecApprovalUnavailablePayload(payload) ||
    hasAskUserPayload(payload)
  );
}

export function createFinalDispatchPayloadDedupeKey(payload: ReplyPayload): string {
  const metadata = getReplyPayloadMetadata(payload);
  return JSON.stringify({
    payload: {
      text: payload.text,
      mediaUrl: payload.mediaUrl,
      mediaUrls: payload.mediaUrls,
      trustedLocalMedia: payload.trustedLocalMedia,
      sensitiveMedia: payload.sensitiveMedia,
      presentation: payload.presentation,
      presentationTextMode: payload.presentationTextMode,
      delivery: payload.delivery,
      interactive: payload.interactive,
      btw: payload.btw,
      replyToId: payload.replyToId,
      replyToTag: payload.replyToTag,
      replyToCurrent: payload.replyToCurrent,
      audioAsVoice: payload.audioAsVoice,
      videoAsNote: payload.videoAsNote === true,
      location: payload.location,
      spokenText: payload.spokenText,
      ttsSupplement: payload.ttsSupplement,
      isError: payload.isError,
      isReasoning: payload.isReasoning,
      isCommentary: payload.isCommentary,
      isReasoningSnapshot: payload.isReasoningSnapshot,
      isCompactionNotice: payload.isCompactionNotice,
      isFallbackNotice: payload.isFallbackNotice,
      isStatusNotice: payload.isStatusNotice,
      channelData: payload.channelData,
    },
    identity: {
      assistantMessageIndex: metadata?.assistantMessageIndex,
      assistantTranscriptOwned: metadata?.assistantTranscriptOwned,
      replyToIdExplicit: metadata?.replyToIdExplicit,
      replyDelivery: metadata?.replyDelivery,
      replyDeliverySource: metadata?.replyDeliverySource,
      sourceReplyTranscriptMirror: metadata?.sourceReplyTranscriptMirror,
    },
  });
}

export async function maybeApplyTtsToReplyPayload(
  params: Parameters<
    Awaited<ReturnType<typeof ttsRuntimeLoader.load>>["maybeApplyTtsToPayload"]
  >[0] & { preparedTtsPreferences: PreparedTtsPreferences },
) {
  if (
    isReplyPayloadStatusNotice(params.payload) &&
    !(
      params.payload.isCompactionNotice === true &&
      getReplyPayloadMetadata(params.payload)?.nativeCompactionNotice === true
    )
  ) {
    return params.payload;
  }
  if (
    !(await shouldAttemptTtsPayload({
      cfg: params.cfg,
      preparedTtsPreferences: params.preparedTtsPreferences,
      ttsAuto: params.ttsAuto,
      agentId: params.agentId,
      channelId: params.channel,
      accountId: params.accountId,
    }))
  ) {
    return params.payload;
  }
  const { maybeApplyTtsToPayload } = await ttsRuntimeLoader.load();
  const ttsPayload = await maybeApplyTtsToPayload(params);
  return ttsPayload === params.payload
    ? ttsPayload
    : copyReplyPayloadMetadata(params.payload, ttsPayload);
}

/** Applies dispatcher normalization before TTS or transcript-visible side effects. */
export function prepareReplyPayloadForSideEffects(
  dispatcher: ReplyDispatcher,
  kind: ReplyDispatchKind,
  payload: ReplyPayload | null | undefined,
  state: { acceptedReplyPayload: boolean; channelTransformSuppressed: boolean },
  onVisibleAccepted?: () => void,
): ReplyPayload | null {
  if (!payload) {
    return null;
  }
  const outcome = prepareReplyPayloadForDispatcher(dispatcher, kind, payload);
  if (outcome.kind === "deliver") {
    state.acceptedReplyPayload = true;
    if (
      outcome.payload.isReasoning !== true &&
      outcome.payload.isCommentary !== true &&
      hasOutboundReplyContent(outcome.payload, { trimText: true })
    ) {
      onVisibleAccepted?.();
    }
    return outcome.payload;
  }
  state.channelTransformSuppressed ||= outcome.reason === "channel_transform";
  return null;
}
