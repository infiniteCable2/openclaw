import type { ProviderLocalServiceLease } from "../../agents/provider-local-service-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { AssistantDeliveryTtsFacts } from "../../llm/types.js";
import type { PluginRuntime, RuntimeLogger } from "../../plugins/runtime/types.js";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import { parseSpeechExpression } from "../../tts/expression.js";
import type {
  RealtimeVoiceAgentConsultResult,
  RealtimeVoiceSpeechUtterance,
} from "../agent-consult-runtime.js";
import type { RealtimeVoiceSessionHarness } from "../realtime-session-harness.js";
import type { RealtimeVoiceTranscriptEntry } from "../session-log-runtime.js";
import { createSpeechAudioPreparation } from "./audio-preparation.js";
import type { createSpeechCancellation } from "./cancellation.js";
import type { SpeechStreamCancellation } from "./stream-cleanup.js";
import {
  formatSpeechTtsResultLog,
  formatSpeechTranscriptSummaryLog,
  normalizeSpeechPromptText,
} from "./support.js";
import type { SpeechAudioTransport } from "./transport.js";
import type { SpeechSessionConfig, SpeechRuntimeSurface } from "./types.js";
import type { createSpeechWaitingController } from "./waiting-controller.js";

export type SpeechUtterance = {
  generation: number;
  waitingGeneration: number;
  waitingTurn?: number;
  chunks: string[];
  transcriptEntries: RealtimeVoiceTranscriptEntry[];
  playbackStarted: boolean;
  finalized: boolean;
  failed: boolean;
};

/** Own the existing per-session synthesis/playout queue; the engine retains turn and generation authority. */
export function createSpeechOutput(params: {
  config: SpeechSessionConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  surface: SpeechRuntimeSurface;
  sessionId: string;
  ttsContext?: { agentId?: string; channelId?: string; accountId?: string };
  ttsAgentId?: string;
  agentLogScope: string;
  logger: RuntimeLogger;
  onActivity?: (activity: "listening" | "sensing" | "hearing" | "processing" | "speaking") => void;
  getHarness: () => RealtimeVoiceSessionHarness;
  isStopped: () => boolean;
  getOutputGeneration: () => number;
  getWaitingTurn: () => number | undefined;
  finishWaitingTurn: (turn: number) => void;
  waitForInput: () => Promise<void>;
  waiting: ReturnType<typeof createSpeechWaitingController>;
  speechCancellation: ReturnType<typeof createSpeechCancellation>;
  activeTtsAborts: Set<AbortController>;
  activeTtsReaders: Set<SpeechStreamCancellation>;
  transport: SpeechAudioTransport;
  onOutputTurn: (turnId: string | undefined) => void;
}) {
  const {
    waiting,
    speechCancellation,
    activeTtsAborts,
    activeTtsReaders,
    ttsAgentId,
    agentLogScope,
  } = params;
  let ttsQueue = Promise.resolve();
  const preparation = createSpeechAudioPreparation({
    audioFormat: params.config.audioFormat,
    platformName: params.surface.displayName,
    activeAborts: activeTtsAborts,
    activeReaders: activeTtsReaders,
  });
  let pendingChunks = 0;
  let handoffPending = false;
  const failedReleases = new Map<() => Promise<void>, { error: unknown; reported: boolean }>();

  const writeOutputAudio = async (
    audio: Buffer,
    firstChunk: boolean,
    isCurrent: () => boolean,
    onHandoff?: () => void,
  ) => {
    const harness = params.getHarness();
    // A newly starting segment waits for unresolved acoustic input; already
    // playing speech remains controlled by the reversible output gate.
    if (firstChunk) {
      await params.waitForInput();
    }
    if (!isCurrent()) {
      return false;
    }
    if (firstChunk) {
      params.transport.beginOutput?.();
      if (!isCurrent()) {
        return false;
      }
      harness.outputActivity.markPlaybackStarted();
    }
    harness.recordOutputAudio(audio);
    params.onOutputTurn(harness.talk.activeTurnId);
    if (!isCurrent()) {
      return false;
    }
    onHandoff?.();
    await params.transport.writeOutput(audio);
    // An accepted handoff stays a fact even when cancellation races the write.
    return true;
  };

  const createSpeechUtterance = (waitingTurn?: number): SpeechUtterance => ({
    generation: params.getOutputGeneration(),
    waitingGeneration: waiting.generation,
    waitingTurn,
    chunks: [],
    transcriptEntries: [],
    playbackStarted: false,
    finalized: false,
    failed: false,
  });

  const isCurrentSpeechUtterance = (utterance: SpeechUtterance) =>
    !params.isStopped() &&
    utterance.generation === params.getOutputGeneration() &&
    !utterance.finalized;

  const enqueueSpeechChunk = (
    text: string | undefined,
    utterance: SpeechUtterance,
    speech?: AssistantDeliveryTtsFacts,
    localServiceAdmission?: NonNullable<ProviderLocalServiceLease["admission"]>,
    expectedSpeechSelection?: RealtimeVoiceSpeechUtterance["expectedSpeechSelection"],
  ) => {
    const harness = params.getHarness();
    const normalized = speech?.expression ? text : normalizeSpeechPromptText(text);
    if (speech?.expression) {
      if (text !== speech.text) {
        throw new Error("Speech utterance changed after expression admission");
      }
      parseSpeechExpression(speech.expression, text ?? "");
      localServiceAdmission?.signal.throwIfAborted();
    }
    if (!normalized || !isCurrentSpeechUtterance(utterance)) {
      return;
    }
    utterance.chunks.push(normalized);
    pendingChunks += 1;
    const transcriptEntry = harness.recordTranscript("assistant", normalized);
    transcriptEntry.audioDelivery = "unplayed";
    utterance.transcriptEntries.push(transcriptEntry);
    params.logger.info(
      formatSpeechTranscriptSummaryLog(
        params.surface.logScope,
        `${agentLogScope} assistant stream`,
        normalized,
      ),
    );
    const playbackDone = createDeferred<void>();
    const prepared = preparation.prepare({
      isCurrent: () => isCurrentSpeechUtterance(utterance),
      playbackDone: playbackDone.promise,
      synthesize: (signal) =>
        params.runtime.tts.streamTextToSpeechTelephony({
          text: normalized,
          ...(speech?.expression ? { overrides: { expression: speech.expression } } : {}),
          ...(localServiceAdmission ? { localServiceAdmission } : {}),
          ...(expectedSpeechSelection ? { expectedSpeechSelection } : {}),
          cfg: params.fullConfig,
          signal,
          ...(ttsAgentId ? { agentId: ttsAgentId } : {}),
          ...(params.ttsContext?.channelId ? { channelId: params.ttsContext.channelId } : {}),
          ...(params.ttsContext?.accountId ? { accountId: params.ttsContext.accountId } : {}),
        }),
    });
    ttsQueue = ttsQueue
      .then(async () => {
        const ready = await prepared;
        if ("skipped" in ready) {
          return;
        }
        const controller = ready.controller;
        if ("error" in ready) {
          activeTtsAborts.delete(controller);
          throw ready.error;
        }
        const result = ready.result;
        const { resources, audio } = ready;
        const release = () => resources.release();
        let cleanupFailure: { error: unknown } | undefined;
        try {
          if (!isCurrentSpeechUtterance(utterance) || controller.signal.aborted) {
            return;
          }
          if (!result.success || !result.audioStream || !result.sampleRate) {
            throw new Error(result.error ?? "TTS conversion failed");
          }
          params.logger.info(
            formatSpeechTtsResultLog(params.surface.logScope, agentLogScope, result),
          );
          harness.ensureTurn();
          let firstSegmentChunk = true;
          let firstUtteranceChunk = !utterance.playbackStarted;
          let bytesWritten = 0;
          const isCurrentPlayback = () =>
            isCurrentSpeechUtterance(utterance) && !controller.signal.aborted;
          try {
            for (;;) {
              if (!isCurrentPlayback()) {
                break;
              }
              const resumedAfterGap = !audio.hasBufferedAudio;
              if (resumedAfterGap && utterance.waitingTurn !== undefined) {
                waiting.onOutputIdle(utterance.waitingTurn);
              }
              const chunk = await audio.read();
              if (!isCurrentPlayback()) {
                break;
              }
              const output = chunk.done ? Buffer.alloc(0) : Buffer.from(chunk.value);
              if (output.byteLength === 0) {
                if (chunk.done) {
                  break;
                }
                continue;
              }
              // Music may resume during read-ahead, but never while its own
              // drain is transitioning into the next speech handoff.
              handoffPending = true;
              try {
                if (firstSegmentChunk || resumedAfterGap) {
                  await params.waitForInput();
                  if (!isCurrentPlayback()) {
                    break;
                  }
                  await waiting.stop();
                }
                if (
                  !(await writeOutputAudio(output, firstUtteranceChunk, isCurrentPlayback, () => {
                    // Accepted output may be audible before a paced write drains.
                    if (transcriptEntry.audioDelivery === "unplayed") {
                      transcriptEntry.audioDelivery = "started";
                    }
                  }))
                ) {
                  break;
                }
              } finally {
                handoffPending = false;
              }
              if (!isCurrentPlayback()) {
                break;
              }
              if (firstUtteranceChunk) {
                utterance.playbackStarted = true;
              }
              if (firstSegmentChunk) {
                params.onActivity?.("speaking");
              }
              firstSegmentChunk = false;
              firstUtteranceChunk = false;
              bytesWritten += output.byteLength;
              if (chunk.done) {
                break;
              }
            }
            if (bytesWritten === 0 && isCurrentPlayback()) {
              throw new Error("TTS provider returned an empty audio stream");
            }
            if (transcriptEntry.audioDelivery === "started") {
              transcriptEntry.audioDelivery = isCurrentPlayback() ? "submitted" : "interrupted";
            }
          } finally {
            if (transcriptEntry.audioDelivery === "started") {
              transcriptEntry.audioDelivery = "interrupted";
            }
            params.onActivity?.(params.getWaitingTurn() === undefined ? "listening" : "processing");
          }
        } finally {
          audio.close();
          try {
            await release();
            // A confirmed input blocked by TTS can resume waiting audio only
            // after the stream owner has released its reader and provider hold.
            if (utterance.waitingTurn !== undefined) {
              waiting.onOutputIdle(utterance.waitingTurn);
            }
          } catch (error) {
            failedReleases.set(release, { error, reported: false });
            cleanupFailure = { error };
          } finally {
            activeTtsAborts.delete(controller);
          }
        }
        // Keep the playback error primary if both phases fail. The retained
        // release owner reports its own failure through drain and can retry.
        if (cleanupFailure) {
          throw cleanupFailure.error;
        }
      })
      .catch((error: unknown) => {
        if (!isCurrentSpeechUtterance(utterance)) {
          return;
        }
        utterance.failed = true;
        utterance.finalized = true;
        if (utterance.waitingTurn !== undefined) {
          params.finishWaitingTurn(utterance.waitingTurn);
        }
        waiting.stopInBackground(utterance.waitingGeneration);
        // TTS and sink failures happen after a turn, and sometimes output, has started.
        // Close both spans so later input cannot inherit stale playback suppression.
        harness.finishOutputAudio("failed");
        harness.endTurn("failed");
        params.logger.warn(
          `${params.surface.logScope} ${agentLogScope} TTS failed: ${formatErrorMessage(error)}`,
        );
      })
      .finally(() => {
        pendingChunks -= 1;
        playbackDone.resolve();
      });
  };

  const finalizeSpeechUtterance = (utterance: SpeechUtterance, text: string | undefined) => {
    const harness = params.getHarness();
    const normalized = normalizeSpeechPromptText(text);
    if (!normalized || !isCurrentSpeechUtterance(utterance)) {
      return;
    }
    if (utterance.chunks.length === 0) {
      enqueueSpeechChunk(normalized, utterance);
    }
    // Text is final independently of whether its audio can be played. Streaming
    // chunks may already be audible, but a buffered reply publishes this first.
    const turnId = harness.ensureTurn();
    harness.emit({
      type: "output.text.done",
      turnId,
      final: true,
      payload: { sessionId: params.sessionId, text: normalized },
    });
    ttsQueue = ttsQueue.then(async () => {
      await params.waitForInput();
      if (!isCurrentSpeechUtterance(utterance) || utterance.failed) {
        return;
      }
      // Only consolidate chunks that reached the sink, not a potentially
      // different final model answer which was never synthesized.
      const submittedText = utterance.transcriptEntries.map((entry) => entry.text).join(" ");
      speechCancellation.removeProvisionalTranscriptEntries(utterance.transcriptEntries);
      if (submittedText) {
        harness.recordTranscript("assistant", submittedText).audioDelivery = "submitted";
      }
      params.logger.info(
        formatSpeechTranscriptSummaryLog(
          params.surface.logScope,
          `${agentLogScope} assistant`,
          normalized,
        ),
      );
      harness.finishOutputAudio("completed");
      harness.endTurn();
      params.onActivity?.("listening");
      utterance.finalized = true;
      if (utterance.waitingTurn !== undefined) {
        params.finishWaitingTurn(utterance.waitingTurn);
      }
    });
  };

  const enqueueSpeechResult = (
    result: RealtimeVoiceAgentConsultResult,
    utterance: SpeechUtterance,
  ) => {
    for (const part of result.utterances ?? []) {
      enqueueSpeechChunk(
        part.text,
        utterance,
        part.speech,
        part.localServiceAdmission,
        part.expectedSpeechSelection,
      );
    }
    finalizeSpeechUtterance(utterance, result.text);
  };

  const enqueueSpeakText = (text: string | undefined) => {
    const utterance = createSpeechUtterance(params.getWaitingTurn());
    enqueueSpeechChunk(text, utterance);
    finalizeSpeechUtterance(utterance, text);
  };

  return {
    writeOutputAudio,
    createSpeechUtterance,
    isCurrentSpeechUtterance,
    enqueueSpeechChunk,
    enqueueSpeechResult,
    enqueueSpeakText,
    finalizeSpeechUtterance,
    hasPendingOutput: () => pendingChunks > 0,
    isHandoffPending: () => handoffPending,
    async drain() {
      await ttsQueue;
      const unreported = [...failedReleases.values()].filter((failure) => !failure.reported);
      if (unreported.length > 0) {
        for (const failure of unreported) {
          failure.reported = true;
        }
        // Playback/synthesis errors are handled above; resource-release errors
        // must remain visible even when cancellation made that output stale.
        throw new AggregateError(
          unreported.map(({ error }) => error),
          "Speech stream cleanup failed",
        );
      }
      const failures: unknown[] = [];
      for (const [release, previous] of failedReleases) {
        try {
          await release();
          failedReleases.delete(release);
        } catch (error) {
          previous.error = error;
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Speech stream cleanup failed");
      }
    },
  };
}
