import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { logVerbose } from "../../globals.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
  type ReplySpeechOutputReceipt,
} from "../reply-payload.js";
import type {
  AgentTurnInternalResult,
  EmbeddedAgentRunResult,
} from "./agent-runner-execution.types.js";

function isTextOnlySpeechPayload(
  payload: ReplyPayload,
): payload is ReplyPayload & { text: string } {
  return Boolean(
    payload.text?.trim() &&
    !payload.mediaUrl &&
    !payload.mediaUrls?.length &&
    !payload.attachments?.length &&
    !payload.presentation &&
    !payload.interactive &&
    !payload.location &&
    !payload.channelData &&
    !payload.btw &&
    !payload.delivery &&
    !payload.fallbackText &&
    !payload.isError &&
    !payload.isReasoning &&
    !payload.isCommentary &&
    !payload.isStatusNotice &&
    !payload.isCompactionNotice &&
    !payload.isFallbackNotice &&
    !getReplyPayloadMetadata(payload)?.precedingInputAnswer,
  );
}

/** Bind exact source content to the output owner's deferred, physical delivery proof. */
export function recordReplySpeechDelivery(
  payload: ReplyPayload,
  binding: Pick<ReplySpeechRunBinding, "runId" | "sessionId">,
  output: ReplySpeechOutputReceipt,
  accepted: Promise<boolean>,
): void {
  if (isTextOnlySpeechPayload(payload)) {
    setReplyPayloadMetadata(payload, {
      speechDeliveryReceipt: Object.freeze({
        runId: binding.runId,
        sessionId: binding.sessionId,
        text: payload.text,
        spokenText: payload.spokenText,
        tts: getReplyPayloadMetadata(payload)?.tts,
        output,
        accepted,
      }),
    });
  }
}

/** Reply normalization may copy metadata, but changed content cannot inherit delivery. */
export function hasReplySpeechDelivery(payload: ReplyPayload): boolean {
  const metadata = getReplyPayloadMetadata(payload);
  const receipt = metadata?.speechDeliveryReceipt;
  return Boolean(
    receipt &&
    (!metadata?.pendingFinalDeliveryCompletion ||
      metadata.pendingFinalDeliveryCompletion.sessionId === receipt.sessionId) &&
    isTextOnlySpeechPayload(payload) &&
    receipt.text === payload.text &&
    receipt.spokenText === payload.spokenText &&
    receipt.tts === metadata?.tts,
  );
}

/** Host-owned presentation only; it cannot grant input, session, or tool authority. */
export type ReplySpeechPresentationSource = Readonly<{
  /** Stable host output connection identity, not session, sender or tool authority. */
  outputOwner?: object;
  guidance?: string;
  modelRequestProfile?: RunEmbeddedAgentParams["modelRequestProfile"];
  blockReplyChunking?: RunEmbeddedAgentParams["blockReplyChunking"];
  speakCommentary: boolean;
  waitForPendingInput?: RunEmbeddedAgentParams["waitForPendingInput"];
  openRun(binding: ReplySpeechRunBinding): ReplySpeechPresentationRun;
  /** Reports output failure without changing the result of already executed work. */
  onError(error: unknown): void;
}>;

export function resolveReplySpeechOutputOwner(source: ReplySpeechPresentationSource | undefined) {
  return source?.outputOwner ?? source;
}

export type ReplySpeechRunBinding = Readonly<{
  runId: string;
  sessionId: string;
  abortSignal: AbortSignal;
  assertCurrent: SessionSourceAssertion;
}>;

export type ReplySpeechPresentationRun = {
  currentSourceReplyTarget?: RunEmbeddedAgentParams["currentSourceReplyTarget"];
  nativeSpeechPresentation?: RunEmbeddedAgentParams["nativeSpeechPresentation"];
  onBlockReply(payload: ReplyPayload): void | Promise<void>;
  finish(result: EmbeddedAgentRunResult): Promise<void>;
  abort(): Promise<void>;
  close(): void | Promise<void>;
};

/** The actual executing turn owns this lifetime, including queued execution and fallbacks. */
export async function withReplySpeechPresentation(
  source: ReplySpeechPresentationSource | undefined,
  binding: ReplySpeechRunBinding,
  run: (speech: ReplySpeechPresentationRun | undefined) => Promise<AgentTurnInternalResult>,
): Promise<AgentTurnInternalResult> {
  if (!source) {
    return run(undefined);
  }
  binding.assertCurrent();
  binding.abortSignal.throwIfAborted();
  const speech = source.openRun(binding);
  const settleOutput = async (action: () => void | Promise<void>) => {
    try {
      await action();
      return true;
    } catch (error) {
      try {
        source.onError(error);
      } catch {
        // A broken output observer must not turn successful tool work into a retry.
        logVerbose("speech presentation failure observer failed");
      }
      return false;
    }
  };
  try {
    binding.assertCurrent();
    binding.abortSignal.throwIfAborted();
    const result = await run(speech);
    const outputSettled = await settleOutput(() =>
      result.kind === "settled" && result.status === "ok" && !binding.abortSignal.aborted
        ? speech.finish(result.result)
        : speech.abort(),
    );
    if (!outputSettled) {
      await settleOutput(() => speech.abort());
    }
    return result;
  } catch (error) {
    await settleOutput(() => speech.abort());
    throw error;
  } finally {
    await settleOutput(() => speech.close());
  }
}
