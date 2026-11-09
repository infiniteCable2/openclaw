import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseCompactionDetails } from "../../../packages/agent-core/src/harness/compaction/compaction-details.js";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { EmbeddedAgentCompactResult } from "../../agents/embedded-agent-runner/types.js";
import { resolveAgentLanguage } from "../../agents/identity.js";
import { isSyntheticSourceReplyTurn } from "../../agents/reply-completion.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { isCurrentSessionControllerOperation } from "../../sessions/session-controller.identity.js";
import { getAttachedBackend } from "../../sessions/session-controller.state.js";
import { resolveUserMessages } from "../../shared/user-messages.js";
import { formatTokenCount } from "../../utils/token-format.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun } from "./queue/types.js";
import type { ReplySpeechPresentationSource } from "./reply-speech-presentation.js";

export type CompactionNoticePhase =
  | "start"
  | "end"
  | "degraded"
  | "incomplete"
  | "skipped"
  | "queued"
  | "context_bounded"
  | "memory_flush_degraded";

export function formatCompactionStatus(
  entry?: Pick<SessionEntry, "compactionCount" | "compactionQualityDegraded">,
): string | undefined {
  const count = entry?.compactionCount ?? 0;
  return entry?.compactionQualityDegraded
    ? `${count} · degraded history (details may be lost)`
    : count > 0
      ? String(count)
      : undefined;
}

export function resolveCompactionCompletionNotice(
  result: EmbeddedAgentCompactResult,
  contextBounded: boolean,
  language?: string,
): { phase: CompactionNoticePhase; text?: string } {
  const details = parseCompactionDetails(result.result?.details);
  if (details?.qualityDegraded) {
    const text = compactionNoticeText("degraded", details.summaryRefused, language);
    return {
      phase: "degraded",
      text: contextBounded
        ? `${text}\n\n${resolveUserMessages(language).compactionNotice.context_bounded}`
        : text,
    };
  }
  if (contextBounded) {
    return { phase: "context_bounded" };
  }
  const before = result.result?.tokensBefore;
  const after = result.result?.tokensAfter;
  return {
    phase: "end",
    text:
      result.compactionKind === "server-endpoint" && before !== undefined && after !== undefined
        ? `🧹 Server-side compaction complete (${formatTokenCount(before)} → ${formatTokenCount(after)})`
        : undefined,
  };
}

export function formatCompactionModelRef(provider?: string, model?: string): string {
  const parts = [provider, model]
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => value !== undefined);
  return parts.length > 0 ? parts.map((value) => sanitizeForLog(value)).join("/") : "unknown model";
}

export type CompactionNoticeTurn = {
  followupRun: Pick<FollowupRun, "currentInboundEventKind" | "speechPresentation"> & {
    run: Pick<
      FollowupRun["run"],
      "inputProvenance" | "internalEventExecution" | "scheduledAutomation"
    >;
  };
  isHeartbeat?: boolean;
  opts?: { internalEventExecution?: unknown };
};

/** Automatic outputs cannot turn global presentation preferences into a user request. */
export function isUserCompactionNoticeTurn(turn: CompactionNoticeTurn): boolean {
  return (
    !turn.opts?.internalEventExecution &&
    !turn.isHeartbeat &&
    !turn.followupRun.run.internalEventExecution &&
    turn.followupRun.currentInboundEventKind !== "room_event" &&
    !isSyntheticSourceReplyTurn({
      inputProvenance: turn.followupRun.run.inputProvenance,
      scheduledAutomation: turn.followupRun.run.scheduledAutomation !== undefined,
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
  isHeartbeat?: boolean;
  opts?: InternalGetReplyOptions;
  currentMessageId?: string;
}) {
  const { operation, followupRun, opts } = params;
  if (
    !operation ||
    !isCurrentSessionControllerOperation(operation) ||
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

function compactionNoticeText(
  phase: CompactionNoticePhase,
  summaryRefused?: boolean,
  language?: string,
): string {
  const messages = resolveUserMessages(language).compactionNotice;
  return phase === "degraded" && summaryRefused ? messages.summaryRefused : messages[phase];
}

export function createCompactionNoticePayload(
  params: CompactionNoticeOptions & {
    phase: CompactionNoticePhase;
    text?: string;
    summaryRefused?: boolean;
  },
): ReplyPayload {
  const payload = createNoticePayload(
    params.text ?? compactionNoticeText(params.phase, params.summaryRefused, params.language),
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

export async function deliverCompactionNoticePayload(
  payload: ReplyPayload,
  deliver: ((payload: ReplyPayload) => unknown) | undefined,
  label: string,
): Promise<void> {
  if (!deliver) {
    return;
  }
  try {
    await deliver(payload);
  } catch (err) {
    logVerbose(`compaction ${label} notice delivery failed (non-fatal): ${String(err)}`);
  }
}
