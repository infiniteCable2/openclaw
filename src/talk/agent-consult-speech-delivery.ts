import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { toErrorObject } from "../infra/errors.js";
import type { CurrentSourceReplyTarget } from "../infra/outbound/message-action-contracts.js";
import type { RuntimeLogger } from "../plugins/runtime/types-core.js";
import { parseSpeechExpression } from "../tts/expression.js";
import type {
  RealtimeVoiceAgentConsultResult,
  RealtimeVoiceAgentConsultSpeechEvent,
  RealtimeVoiceSpeechExpressionContext,
  RealtimeVoiceSpeechUtterance,
} from "./agent-consult-runtime.js";
import { collectRealtimeVoiceAgentConsultVisibleText } from "./agent-consult-tool.js";

function hasQueuedSpeechSuffix(chunks: readonly string[], text: string): boolean {
  let remaining = text.replaceAll(/\s+/g, " ").trim();
  for (const queuedChunk of chunks.toReversed()) {
    const chunk = queuedChunk.replaceAll(/\s+/g, " ").trim();
    if (remaining === chunk) {
      return true;
    }
    if (!remaining.endsWith(` ${chunk}`)) {
      return false;
    }
    remaining = remaining.slice(0, -chunk.length - 1);
  }
  return false;
}

/** Presentation state of one native consult; its caller retains admission, lifetime and yield custody. */
export function createRealtimeVoiceConsultSpeechDelivery(params: {
  runId: string;
  sessionId: string;
  abortSignal: AbortSignal;
  assertExpressionCurrent(): void;
  assertNotInterrupted(): void;
  onSpeakableText?: (event: RealtimeVoiceAgentConsultSpeechEvent) => void | Promise<void>;
  speakCommentary?: boolean;
  speechExpressionContext?: RealtimeVoiceSpeechExpressionContext;
  speechExpressionCaptureOnly?: true;
  fallbackText?: string;
  logger: Pick<RuntimeLogger, "warn">;
}) {
  const { runId, sessionId, abortSignal, assertExpressionCurrent } = params;
  const streamedChunks: string[] = [];
  let commentarySpeechQueued = false;
  const spokenCommentaryEnabled =
    params.speakCommentary === true && Boolean(params.onSpeakableText);
  let speechDelivery = Promise.resolve();
  let speechDeliveryError: Error | undefined;
  let speechDeliveryAborted = false;
  let speechAbortCompletion: Promise<void> | undefined;
  const expressiveUtterances: Array<
    RealtimeVoiceSpeechUtterance & { phase: "commentary" | "final_answer" }
  > = [];
  let expressionComplete = false;
  let expressiveInput: object | undefined;
  const acceptedExpressionCalls = new Map<
    string,
    { fingerprint: string; completion: Promise<void> }
  >();
  const emitSpeechEvent = (event: RealtimeVoiceAgentConsultSpeechEvent) => {
    if (!params.onSpeakableText || speechDeliveryError || speechDeliveryAborted) {
      return;
    }
    speechDelivery = speechDelivery
      .then(async () => {
        if (!speechDeliveryAborted && !speechDeliveryError && !abortSignal.aborted) {
          if (params.speechExpressionContext) {
            assertExpressionCurrent();
          }
          await params.onSpeakableText?.(event);
        }
      })
      .catch((error: unknown) => {
        speechDeliveryError = toErrorObject(error, "Realtime voice speech delivery failed");
      });
    return speechDelivery;
  };
  const currentSourceReplyTarget: CurrentSourceReplyTarget | undefined =
    params.speechExpressionContext
      ? {
          runId,
          sessionId,
          assertCurrent: assertExpressionCurrent,
          beginInput(input) {
            assertExpressionCurrent();
            expressiveInput = input;
            expressiveUtterances.length = 0;
            expressionComplete = false;
          },
          speechExpressionRequired: true,
          ...(params.speechExpressionCaptureOnly ? { sourceOnly: true as const } : {}),
          async deliver(payload: ReplyPayload, context) {
            assertExpressionCurrent();
            const inputOwner = expressiveInput;
            const speech = getReplyPayloadMetadata(payload)?.tts;
            if (!speech?.expression || speech.text === undefined || speech.text !== payload.text) {
              throw new Error("Expressive speech requires exact structured utterance facts");
            }
            const spokenText = speech.text;
            parseSpeechExpression(speech.expression, spokenText);
            const callKey = context.idempotencyKey ?? context.toolCallId;
            const fingerprint = JSON.stringify({
              speech,
              final: context.final,
              phase: context.phase,
            });
            const previous = callKey ? acceptedExpressionCalls.get(callKey) : undefined;
            if (previous) {
              if (previous.fingerprint !== fingerprint) {
                throw new Error(
                  "Current-source utterance identity was reused with different content",
                );
              }
              await previous.completion;
              assertExpressionCurrent();
              return;
            }
            if (context.phase === "commentary" && !spokenCommentaryEnabled) {
              throw new Error("Spoken commentary is not enabled for this source");
            }
            // Reserve the native call identity before an awaited sink handoff.
            // Duplicate invocations join its outcome, even across input adoption.
            const completion = Promise.resolve().then(async () => {
              assertExpressionCurrent();
              if (inputOwner !== expressiveInput) {
                throw new Error("Current-source utterance input was replaced before delivery");
              }
              if (params.onSpeakableText && !params.speechExpressionCaptureOnly) {
                await emitSpeechEvent({
                  type: "chunk",
                  text: spokenText,
                  speech,
                  localServiceAdmission: params.speechExpressionContext?.localServiceAdmission,
                  expectedSpeechSelection: params.speechExpressionContext?.expectedSpeechSelection,
                });
                assertExpressionCurrent();
                if (speechDeliveryError) {
                  throw speechDeliveryError;
                }
              }
              if (inputOwner !== expressiveInput) {
                return;
              }
              expressiveUtterances.push({
                text: spokenText,
                speech,
                phase: context.phase,
                localServiceAdmission: params.speechExpressionContext?.localServiceAdmission,
                expectedSpeechSelection: params.speechExpressionContext?.expectedSpeechSelection,
              });
              expressionComplete ||= context.final && context.phase === "final_answer";
            });
            if (callKey) {
              acceptedExpressionCalls.set(callKey, { fingerprint, completion });
            }
            await completion;
          },
        }
      : undefined;
  const abortSpeechDelivery = (): Promise<void> => {
    if (!params.onSpeakableText || params.speechExpressionCaptureOnly) {
      return Promise.resolve();
    }
    speechDeliveryAborted = true;
    return (speechAbortCompletion ??= Promise.resolve().then(async () => {
      try {
        // Notify the sink before joining: abort may release an in-flight write.
        await params.onSpeakableText?.({ type: "abort" });
      } catch {
        // Preserve the original consult or delivery failure.
      }
      await speechDelivery;
    }));
  };

  const onBlockReply = (payload: {
    text?: string;
    isError?: boolean;
    isReasoning?: boolean;
    isCommentary?: boolean;
  }) => {
    if (payload.isCommentary) {
      if (
        spokenCommentaryEnabled &&
        !payload.isError &&
        !payload.isReasoning &&
        typeof payload.text === "string" &&
        payload.text.trim()
      ) {
        commentarySpeechQueued = true;
        emitSpeechEvent({ type: "chunk", text: payload.text.trim() });
      }
      return;
    }
    const text = collectRealtimeVoiceAgentConsultVisibleText([payload]);
    if (!text) {
      return;
    }
    streamedChunks.push(text);
    emitSpeechEvent({ type: "chunk", text });
  };

  const finish = async ({
    yielded,
    acknowledgment,
    payloads,
  }: {
    yielded: boolean;
    acknowledgment?: string;
    payloads: ReplyPayload[];
  }): Promise<RealtimeVoiceAgentConsultResult> => {
    if (currentSourceReplyTarget) {
      assertExpressionCurrent();
      if (acknowledgment) {
        const answerParts = expressiveUtterances.filter((part) => part.phase === "final_answer");
        const alreadyQueued =
          answerParts.at(-1)?.text.replaceAll(/\s+/g, " ").trim() === acknowledgment ||
          answerParts
            .map((part) => part.text)
            .join(" ")
            .replaceAll(/\s+/g, " ")
            .trim() === acknowledgment;
        if (!alreadyQueued) {
          // Native yield owns task custody. Its host acknowledgment is speech,
          // not evidence that a completed source reply or deferred work finished.
          await currentSourceReplyTarget.deliver(
            setReplyPayloadMetadata(
              { text: acknowledgment },
              {
                tts: {
                  tagged: true,
                  text: acknowledgment,
                  expression: { parts: [{ text: acknowledgment }] },
                },
              },
            ),
            { final: false, phase: "final_answer", idempotencyKey: `${runId}:host-yield-ack` },
          );
          assertExpressionCurrent();
        }
      }
      if ((!expressionComplete && !yielded) || expressiveUtterances.length === 0) {
        throw new Error(
          "Enabled speech expression did not produce a completed native current-source reply",
        );
      }
      const text = expressiveUtterances
        .filter((part) => part.phase === "final_answer")
        .map((part) => part.text)
        .join(" ");
      if (params.onSpeakableText && !params.speechExpressionCaptureOnly) {
        await emitSpeechEvent({ type: "done", text });
        assertExpressionCurrent();
        if (speechDeliveryError) {
          throw speechDeliveryError;
        }
      }
      return {
        text,
        ...(yielded ? { yielded: true as const } : {}),
        utterances: expressiveUtterances.map(({ phase: _phase, ...utterance }) => utterance),
        ...(params.onSpeakableText && !params.speechExpressionCaptureOnly
          ? { delivered: true }
          : {}),
      };
    }

    let yieldedSpeech = acknowledgment;
    if (acknowledgment && (streamedChunks.length > 0 || commentarySpeechQueued)) {
      const spoken = collectRealtimeVoiceAgentConsultVisibleText(
        streamedChunks.map((chunk) => ({ text: chunk })),
      );
      const alreadyQueued =
        streamedChunks.at(-1)?.replaceAll(/\s+/g, " ").trim() === acknowledgment ||
        spoken?.replaceAll(/\s+/g, " ").trim() === acknowledgment;
      // A done event consolidates already queued speech; it does not append new
      // audio after chunks. Yield acknowledgments therefore need their own chunk.
      if (!alreadyQueued) {
        streamedChunks.push(acknowledgment);
        emitSpeechEvent({ type: "chunk", text: acknowledgment });
      }
      yieldedSpeech =
        collectRealtimeVoiceAgentConsultVisibleText(
          streamedChunks.map((chunk) => ({ text: chunk })),
        ) ?? acknowledgment;
    }
    // Earlier segments remain in native context, but may have been superseded
    // by a correction. Only the model's current answer decides what to repeat.
    const currentInputPayloads = payloads.filter(
      (payload) => getReplyPayloadMetadata(payload)?.precedingInputAnswer !== true,
    );
    const text =
      yieldedSpeech ??
      collectRealtimeVoiceAgentConsultVisibleText(currentInputPayloads) ??
      // Chunks have no input ownership. After a proven input boundary they
      // cannot recover the current answer from already spoken earlier text.
      (currentInputPayloads.length === payloads.length
        ? collectRealtimeVoiceAgentConsultVisibleText(
            streamedChunks.map((streamedText) => ({ text: streamedText })),
          )
        : null);
    if (!text) {
      params.logger.warn(
        "[talk] agent consult produced no answer: agent returned no speakable text",
      );
      const fallbackText =
        params.fallbackText ?? "I need a moment to verify that before answering.";
      if (streamedChunks.length > 0 || commentarySpeechQueued) {
        // As with yield acknowledgments, done does not append new audio.
        emitSpeechEvent({ type: "chunk", text: fallbackText });
      }
      emitSpeechEvent({ type: "done", text: fallbackText });
      await speechDelivery;
      params.assertNotInterrupted();
      if (speechDeliveryError) {
        throw speechDeliveryError;
      }
      return {
        text: fallbackText,
        ...(params.onSpeakableText ? { delivered: true } : {}),
      };
    }
    if (
      !yielded &&
      ((currentInputPayloads.length < payloads.length && streamedChunks.length > 0) ||
        (commentarySpeechQueued && streamedChunks.length === 0)) &&
      !hasQueuedSpeechSuffix(streamedChunks, text)
    ) {
      // Earlier-input speech may be all the sink has received. Done only
      // consolidates queued audio; append the current answer unless already queued.
      emitSpeechEvent({ type: "chunk", text });
    }
    emitSpeechEvent({ type: "done", text });
    await speechDelivery;
    params.assertNotInterrupted();
    if (speechDeliveryError) {
      throw speechDeliveryError;
    }
    return {
      text,
      ...(yielded ? { yielded: true as const } : {}),
      ...(params.onSpeakableText ? { delivered: true } : {}),
    };
  };

  return {
    currentSourceReplyTarget,
    spokenCommentaryEnabled,
    onBlockReply,
    abortSpeechDelivery,
    finish,
    get abortCompletion() {
      return speechAbortCompletion;
    },
  };
}
