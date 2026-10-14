// Message-action TTS helpers lazily apply session/config driven speech output
// to send payloads without loading TTS providers for ordinary sends.
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { MessageSpeechAdmission } from "../../tts/message-speech-admission.js";
import { normalizeTtsAutoMode } from "../../tts/tts-auto-mode.js";
import { shouldAttemptTtsPayload } from "../../tts/tts-config.js";
import { prepareTtsPreferences } from "../../tts/tts-preferences.js";
import { resolveSendableOutboundReplyParts } from "./reply-payload-parts.js";
import { sourceDeliveryTargetsMatch } from "./source-delivery-plan.js";

// Keep the TTS runtime lazy so ordinary message sends do not pay the provider import cost.
const loadMessageActionTtsRuntime = createLazyRuntimeModule(
  () => import("../../tts/tts.runtime.js"),
);

/** Exact resolved native handoff route, never the model's requested destination alone. */
function resolveMessageSpeechAdmission(params: {
  admission?: MessageSpeechAdmission;
  runId?: string;
  sessionId?: string;
  agentId?: string;
  channel: string;
  accountId?: string | null;
  target?: string;
  threadId?: string | number;
}): MessageSpeechAdmission | undefined {
  const admission = params.admission;
  if (
    !admission ||
    admission.agentId !== params.agentId ||
    normalizeAccountId(admission.route.accountId) !==
      normalizeAccountId(params.accountId ?? undefined) ||
    !sourceDeliveryTargetsMatch(
      {
        provider: params.channel,
        accountId: params.accountId ?? undefined,
        to: params.target,
        threadId: params.threadId == null ? undefined : String(params.threadId),
      },
      admission.route,
    )
  ) {
    return undefined;
  }
  if (admission.runId !== params.runId || admission.sessionId !== params.sessionId) {
    throw new Error("Native message speech admission does not belong to this run");
  }
  admission.assertCurrent();
  return admission;
}

export async function maybeApplyTtsToMessageActionSendPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  agentId?: string;
  sessionKey?: string;
  inboundAudio?: boolean;
  dryRun: boolean;
  target?: string;
  threadId?: string | number;
  runId?: string;
  sessionId?: string;
  messageSpeechAdmission?: MessageSpeechAdmission;
  signal?: AbortSignal;
  assertCommitAllowed?: () => void;
}): Promise<ReplyPayload> {
  if (params.dryRun) {
    return params.payload;
  }
  params.signal?.throwIfAborted();
  const hasExistingMedia = resolveSendableOutboundReplyParts(params.payload).hasMedia;
  const hasSpeechText = Boolean(
    params.payload.text?.trim() || getReplyPayloadMetadata(params.payload)?.tts?.text,
  );
  const speechAdmission =
    hasExistingMedia || !hasSpeechText
      ? undefined
      : resolveMessageSpeechAdmission({ ...params, admission: params.messageSpeechAdmission });
  const sessionKey = params.sessionKey?.trim();
  let ttsAuto: TtsAutoMode | undefined = normalizeTtsAutoMode(speechAdmission?.sessionAuto);
  if (!speechAdmission && sessionKey) {
    try {
      const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId: params.agentId,
      });
      ttsAuto = loadSessionEntryReadOnly({
        agentId: params.agentId,
        sessionKey,
        storePath,
      })?.ttsAuto;
    } catch {
      // Missing or unreadable session stores should not block message delivery.
    }
  }
  const explicitTts = getReplyPayloadMetadata(params.payload)?.ttsExplicit === true;
  const preparedTtsPreferences =
    speechAdmission?.preparedTtsPreferences ?? (await prepareTtsPreferences());
  params.signal?.throwIfAborted();
  speechAdmission?.assertCurrent();
  if (
    !explicitTts &&
    !shouldAttemptTtsPayload({
      cfg: params.cfg,
      preparedTtsPreferences,
      ttsAuto,
      agentId: params.agentId,
      channelId: params.channel,
      accountId: params.accountId ?? undefined,
    })
  ) {
    return params.payload;
  }
  const { maybeApplyTtsToPayload } = await loadMessageActionTtsRuntime();
  params.signal?.throwIfAborted();
  speechAdmission?.assertCurrent();
  return await maybeApplyTtsToPayload({
    payload: params.payload,
    preparedTtsPreferences,
    cfg: params.cfg,
    channel: params.channel,
    kind: "final",
    inboundAudio: params.inboundAudio,
    ttsAuto,
    agentId: params.agentId,
    accountId: params.accountId ?? undefined,
    messageSpeechAdmission: speechAdmission,
    signal: params.signal,
    assertCommitAllowed: params.assertCommitAllowed,
  });
}
