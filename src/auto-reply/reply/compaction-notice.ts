import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { resolveAgentLanguage } from "../../agents/identity.js";
import { isSyntheticSourceReplyTurn } from "../../agents/reply-completion.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { resolveUserMessages } from "../../shared/user-messages.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun } from "./queue/types.js";
import { type ReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { getAttachedBackend } from "./reply-run-registry.state.js";
import type { ReplySpeechPresentationSource } from "./reply-speech-presentation.js";

export type CompactionNoticePhase =
  | "start"
  | "end"
  | "incomplete"
  | "skipped"
  | "queued"
  | "context_bounded"
  | "memory_flush_degraded";

export function formatCompactionModelRef(provider?: string, model?: string): string {
  const parts = [provider, model]
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => value !== undefined);
  return parts.length > 0 ? parts.map((value) => sanitizeForLog(value)).join("/") : "unknown model";
}

export type CompactionNoticeTurn = {
  followupRun: Pick<FollowupRun, "currentInboundEventKind" | "speechPresentation"> & {
    run: Pick<FollowupRun["run"], "inputProvenance" | "internalEventExecution">;
  };
  isHeartbeat: boolean;
  opts?: { internalEventExecution?: unknown };
};

/** Automatic outputs cannot turn global presentation preferences into a user request. */
export function isUserCompactionNoticeTurn(turn: CompactionNoticeTurn): boolean {
  return (
    !turn.opts?.internalEventExecution &&
    !turn.followupRun.run.internalEventExecution &&
    turn.followupRun.currentInboundEventKind !== "room_event" &&
    !isSyntheticSourceReplyTurn({
      isHeartbeat: turn.isHeartbeat,
      inputProvenance: turn.followupRun.run.inputProvenance,
    })
  );
}

export function shouldNotifyUserAboutCompaction(
  cfg: OpenClawConfig | undefined,
  turn: CompactionNoticeTurn,
): boolean {
  return cfg?.agents?.defaults?.compaction?.notifyUser === true && isUserCompactionNoticeTurn(turn);
}

/** Observe the existing execution owner; a queued request does not create maintenance. */
export function isCompactionNoticePending(operation: ReplyOperation | undefined): boolean {
  return Boolean(
    operation &&
    !operation.result &&
    !operation.abortSignal.aborted &&
    (operation.phase === "preflight_compacting" ||
      getAttachedBackend(operation)?.isCompacting?.() === true),
  );
}

export async function notifyAcceptedInputDuringCompaction(params: {
  operation?: ReplyOperation;
  followupRun: FollowupRun;
  isHeartbeat: boolean;
  opts?: InternalGetReplyOptions;
  currentMessageId?: string;
}) {
  const { operation, followupRun, opts } = params;
  if (
    !operation ||
    replyRunRegistry.get(operation.key) !== operation ||
    !isCompactionNoticePending(operation)
  ) {
    return;
  }
  try {
    opts?.abortSignal?.throwIfAborted();
    followupRun.operatorAuthority?.assertCurrent();
    followupRun.assertSourceCurrent?.();
  } catch {
    return;
  }
  await createDirectCompactionNoticeSender({
    cfg: followupRun.run.config,
    language: resolveAgentLanguage(followupRun.run.config, followupRun.run.agentId),
    turn: params,
    opts,
    currentMessageId: params.currentMessageId,
  })("queued");
}

/** A closed source's sink still owns the status; it cannot fall back to another route. */
export async function deliverSpeechSourceCompactionNotice(
  source: ReplySpeechPresentationSource | undefined,
  payload: ReplyPayload,
): Promise<boolean> {
  if (!source) {
    return false;
  }
  try {
    await source.onCompactionNotice?.(payload);
  } catch {
    logVerbose("speech compaction notice delivery failed (non-fatal)");
  }
  return true;
}

type CompactionNoticeOptions = {
  language?: string;
  currentMessageId?: string;
  applyReplyToMode?: (payload: ReplyPayload) => ReplyPayload;
};

function createNoticePayload(text: string, params: CompactionNoticeOptions): ReplyPayload {
  const payload: ReplyPayload = {
    text,
    ...(params.currentMessageId ? { replyToId: params.currentMessageId } : {}),
    replyToCurrent: true,
    isCompactionNotice: true,
  };
  return params.applyReplyToMode ? params.applyReplyToMode(payload) : payload;
}

export function createCompactionNoticePayload(
  params: CompactionNoticeOptions & { phase: CompactionNoticePhase; text?: string },
): ReplyPayload {
  const payload = createNoticePayload(
    params.text ?? resolveUserMessages(params.language).compactionNotice[params.phase],
    params,
  );
  return params.text === undefined
    ? setReplyPayloadMetadata(payload, { nativeCompactionNotice: true })
    : payload;
}

export function createDirectCompactionNoticeSender(
  params: CompactionNoticeOptions & {
    cfg: OpenClawConfig;
    turn: CompactionNoticeTurn;
    opts?: Pick<GetReplyOptions, "onBlockReply" | "onCompactionNotice">;
  },
) {
  return async (phase: CompactionNoticePhase, text?: string) => {
    const speech = params.turn.followupRun.speechPresentation;
    const deliver =
      params.opts?.onCompactionNotice ??
      (speech
        ? async (payload: ReplyPayload) => {
            await deliverSpeechSourceCompactionNotice(speech, payload);
          }
        : params.opts?.onBlockReply);
    if (
      !deliver ||
      !isUserCompactionNoticeTurn(params.turn) ||
      (phase !== "context_bounded" && !shouldNotifyUserAboutCompaction(params.cfg, params.turn))
    ) {
      return;
    }
    const noticePayload = createCompactionNoticePayload({ ...params, phase, text });
    try {
      await deliver(noticePayload);
    } catch (err) {
      logVerbose(`context maintenance notice delivery failed: ${String(err)}`);
    }
  };
}

export function createCompactionHookNoticePayload(
  params: CompactionNoticeOptions & { messages: string[] },
): ReplyPayload | undefined {
  if (params.messages.length === 0) {
    return undefined;
  }
  return createNoticePayload(params.messages.join("\n\n"), params);
}
