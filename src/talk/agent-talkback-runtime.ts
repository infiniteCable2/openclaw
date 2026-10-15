/**
 * Debounced realtime voice talkback queue for delegated OpenClaw consults.
 *
 * Transcript fragments can arrive quickly while one consult is already running;
 * this queue batches compatible fragments, runs consults serially, and aborts
 * cleanly when the voice session closes.
 */
import type { RuntimeLogger } from "../plugins/runtime/types-core.js";

const MAX_PENDING_QUESTIONS = 32;
const MAX_PENDING_QUESTION_CHARS = 32 * 1024;

export type RealtimeVoiceAgentTalkbackResult = {
  text: string;
  /** The consult already delivered this answer through its low-latency speech sink. */
  delivered?: boolean;
};

export type RealtimeVoiceAgentTalkbackQueue = {
  close(): void;
  enqueue(question: string, metadata?: unknown): boolean;
  isIdle(): boolean;
};

export type RealtimeVoiceAgentTalkbackQueueParams = {
  /** Delay used to merge nearby transcript fragments into one consult. */
  debounceMs: number;
  isStopped: () => boolean;
  logger: Pick<RuntimeLogger, "info" | "warn">;
  logPrefix: string;
  responseStyle: string;
  fallbackText: string;
  /** Release ingress-owned media that was queued but never admitted to a consult. */
  onDiscardMetadata?: (metadata: unknown) => void;
  /** A trusted ingress can preserve native text batching while combining its media snapshots. */
  metadataMergeKey?: (metadata: unknown) => unknown;
  mergeMetadata?: (current: unknown, next: unknown) => unknown;
  /** Delegates a batched question to OpenClaw and respects the abort signal. */
  consult: (args: {
    question: string;
    metadata?: unknown;
    responseStyle: string;
    signal: AbortSignal;
  }) => Promise<RealtimeVoiceAgentTalkbackResult>;
  /** Delivers final speakable text back to the realtime provider/session. */
  deliver: (text: string) => void;
};

type PendingQuestion = {
  question: string;
  metadata?: unknown;
};

export function createRealtimeVoiceAgentTalkbackQueue(
  params: RealtimeVoiceAgentTalkbackQueueParams,
): RealtimeVoiceAgentTalkbackQueue {
  let active = false;
  let closed = false;
  let pendingQuestions: PendingQuestion[] = [];
  let pendingQuestionChars = 0;
  let overflowWarned = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let activeAbortController: AbortController | undefined;

  const shouldStop = () => closed || params.isStopped();

  const clearDebounceTimer = () => {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  };

  const appendPendingQuestion = (next: PendingQuestion): boolean => {
    const current = pendingQuestions.at(-1);
    const currentKey = current && params.metadataMergeKey?.(current.metadata);
    const mergeMetadata =
      currentKey !== undefined && Object.is(currentKey, params.metadataMergeKey?.(next.metadata));
    const mergeWithCurrent =
      current !== undefined &&
      (Object.is(current.metadata, next.metadata) ||
        (mergeMetadata && params.mergeMetadata !== undefined));
    const addedChars = next.question.length + (mergeWithCurrent ? 1 : 0);
    const exceedsQuestionLimit =
      !mergeWithCurrent && pendingQuestions.length >= MAX_PENDING_QUESTIONS;
    const exceedsCharacterLimit = pendingQuestionChars + addedChars > MAX_PENDING_QUESTION_CHARS;
    if (exceedsQuestionLimit || exceedsCharacterLimit) {
      if (!overflowWarned) {
        overflowWarned = true;
        params.logger.warn(
          `${params.logPrefix} consult queue full: droppedChars=${next.question.length} queued=${pendingQuestions.length} queuedChars=${pendingQuestionChars}`,
        );
      }
      return false;
    }
    if (current && mergeWithCurrent) {
      // Metadata identity represents the caller/context lane; merge only when the
      // same lane produced adjacent fragments.
      current.question = `${current.question}\n${next.question}`;
      if (mergeMetadata) {
        current.metadata = params.mergeMetadata?.(current.metadata, next.metadata);
      }
    } else {
      pendingQuestions.push(next);
    }
    pendingQuestionChars += addedChars;
    return true;
  };

  const shiftPendingQuestion = (): PendingQuestion | undefined => {
    const next = pendingQuestions.shift();
    if (!next) {
      return undefined;
    }
    pendingQuestionChars -= next.question.length;
    if (pendingQuestions.length === 0) {
      overflowWarned = false;
    }
    return next;
  };

  const clearPendingQuestions = () => {
    for (const pending of pendingQuestions) {
      params.onDiscardMetadata?.(pending.metadata);
    }
    pendingQuestions = [];
    pendingQuestionChars = 0;
    overflowWarned = false;
  };

  const run = async (pending: PendingQuestion): Promise<void> => {
    if (shouldStop()) {
      return;
    }
    if (active) {
      appendPendingQuestion(pending);
      return;
    }
    active = true;
    let nextQuestion: PendingQuestion | undefined = pending;
    let consultStartedAt: number | undefined;
    try {
      while (nextQuestion) {
        if (shouldStop()) {
          return;
        }
        const currentQuestion = nextQuestion;
        consultStartedAt = Date.now();
        params.logger.info(
          `${params.logPrefix} consult: chars=${currentQuestion.question.length} queued=${pendingQuestions.length}`,
        );
        activeAbortController = new AbortController();
        const result = await params.consult({
          question: currentQuestion.question,
          metadata: currentQuestion.metadata,
          responseStyle: params.responseStyle,
          signal: activeAbortController.signal,
        });
        activeAbortController = undefined;
        const text = result.text.trim();
        params.logger.info(
          `${params.logPrefix} consult done: elapsedMs=${Date.now() - consultStartedAt} answerChars=${text.length} queued=${pendingQuestions.length}`,
        );
        if (!shouldStop() && text && result.delivered !== true) {
          params.deliver(text);
        }
        nextQuestion = shiftPendingQuestion();
      }
    } catch (error) {
      activeAbortController = undefined;
      if (shouldStop() || isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const elapsedDetail =
        consultStartedAt === undefined ? "" : ` elapsedMs=${Date.now() - consultStartedAt}`;
      params.logger.warn(`${params.logPrefix} consult failed:${elapsedDetail} ${message}`);
      params.deliver(params.fallbackText);
    } finally {
      active = false;
      if (shouldStop()) {
        clearPendingQuestions();
      } else {
        const queuedQuestion = shiftPendingQuestion();
        if (queuedQuestion) {
          void run(queuedQuestion);
        }
      }
    }
  };

  return {
    isIdle: () => !active && pendingQuestions.length === 0,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      clearDebounceTimer();
      clearPendingQuestions();
      activeAbortController?.abort();
    },
    enqueue: (question, metadata) => {
      const trimmed = question.trim();
      if (!trimmed || shouldStop()) {
        return false;
      }
      if (active) {
        const accepted = appendPendingQuestion({ question: trimmed, metadata });
        if (accepted) {
          params.logger.info(
            `${params.logPrefix} consult queued: chars=${trimmed.length} queued=${pendingQuestions.length}`,
          );
        }
        clearDebounceTimer();
        return accepted;
      }
      if (!appendPendingQuestion({ question: trimmed, metadata })) {
        return false;
      }
      clearDebounceTimer();
      // Debounce short transcript bursts so partial ASR fragments become a
      // single consult question instead of multiple back-to-back agent turns.
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        const queuedQuestion = shiftPendingQuestion();
        if (queuedQuestion && !shouldStop()) {
          void run(queuedQuestion);
        }
      }, params.debounceMs);
      debounceTimer.unref?.();
      return true;
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
