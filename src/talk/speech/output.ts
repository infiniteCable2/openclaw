import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../../plugins/runtime/types.js";
import type { RealtimeVoiceSessionHarness } from "../realtime-session-harness.js";
import type { RealtimeVoiceTranscriptEntry } from "../session-log-runtime.js";
import { createSpeechTtsAudioStreamConverter } from "./audio-format.js";
import type { createSpeechCancellation } from "./cancellation.js";
import { createSpeechStreamCleanup, type SpeechStreamCancellation } from "./stream-cleanup.js";
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
  let nextTtsPreparationGate = Promise.resolve();
  let pendingChunks = 0;
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

  const enqueueSpeechChunk = (text: string | undefined, utterance: SpeechUtterance) => {
    const harness = params.getHarness();
    const normalized = normalizeSpeechPromptText(text);
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
    let allowNextPreparationResolve: (() => void) | undefined;
    const allowNextPreparationPromise = new Promise<void>((resolve) => {
      allowNextPreparationResolve = resolve;
    });
    let nextPreparationAllowed = false;
    const allowNextPreparation = () => {
      if (nextPreparationAllowed) {
        return;
      }
      nextPreparationAllowed = true;
      allowNextPreparationResolve?.();
    };
    const preparationGate = nextTtsPreparationGate;
    nextTtsPreparationGate = allowNextPreparationPromise;
    const prepared = preparationGate.then(async () => {
      if (!isCurrentSpeechUtterance(utterance)) {
        return { skipped: true } as const;
      }
      const controller = new AbortController();
      activeTtsAborts.add(controller);
      try {
        const result = await params.runtime.tts.streamTextToSpeechTelephony({
          text: normalized,
          cfg: params.fullConfig,
          signal: controller.signal,
          ...(ttsAgentId ? { agentId: ttsAgentId } : {}),
          ...(params.ttsContext?.channelId ? { channelId: params.ttsContext.channelId } : {}),
          ...(params.ttsContext?.accountId ? { accountId: params.ttsContext.accountId } : {}),
        });
        return { result, controller } as const;
      } catch (error) {
        return { error, controller } as const;
      }
    });
    ttsQueue = ttsQueue
      .then(async () => {
        const preparation = await prepared;
        if ("skipped" in preparation) {
          allowNextPreparation();
          return;
        }
        const controller = preparation.controller;
        if ("error" in preparation) {
          activeTtsAborts.delete(controller);
          allowNextPreparation();
          throw preparation.error;
        }
        const result = preparation.result;
        const resources = createSpeechStreamCleanup(result, activeTtsReaders);
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
          resources.open();
          let firstSegmentChunk = true;
          let firstUtteranceChunk = !utterance.playbackStarted;
          let bytesWritten = 0;
          const isCurrentPlayback = () =>
            isCurrentSpeechUtterance(utterance) && !controller.signal.aborted;
          try {
            const converter = createSpeechTtsAudioStreamConverter(
              result.sampleRate,
              params.config.audioFormat,
              result.outputFormat,
              params.surface.displayName,
            );
            for (;;) {
              if (!isCurrentPlayback()) {
                break;
              }
              const chunk = await resources.read();
              if (!isCurrentPlayback()) {
                break;
              }
              // Flush the filter only at natural EOF. Cancellation must never play
              // its retained tail, and buffered samples are not playback yet.
              const output = chunk.done
                ? converter.flush()
                : converter.process(Buffer.from(chunk.value));
              if (output.byteLength === 0) {
                if (chunk.done) {
                  break;
                }
                continue;
              }
              if (firstSegmentChunk) {
                // A candidate can start in a gap with no active playback gate.
                // Hold every newly starting segment, including later commentary.
                await params.waitForInput();
                if (!isCurrentPlayback()) {
                  break;
                }
                // A stream handle is not audible output. Keep the waiting loop
                // through synthesis and buffering, then drain before each segment resumes PCM.
                await waiting.stop();
              }
              if (
                !(await writeOutputAudio(output, firstUtteranceChunk, isCurrentPlayback, () => {
                  // A pending sink write may already be audible. Echo suppression
                  // must see the admitted handoff, not wait for the sink to drain.
                  if (transcriptEntry.audioDelivery === "unplayed") {
                    transcriptEntry.audioDelivery = "started";
                  }
                }))
              ) {
                break;
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
              if (firstSegmentChunk) {
                allowNextPreparation();
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
            allowNextPreparation();
            params.onActivity?.(params.getWaitingTurn() === undefined ? "listening" : "processing");
          }
        } finally {
          allowNextPreparation();
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

  return {
    writeOutputAudio,
    createSpeechUtterance,
    isCurrentSpeechUtterance,
    enqueueSpeechChunk,
    finalizeSpeechUtterance,
    hasPendingOutput: () => pendingChunks > 0,
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
