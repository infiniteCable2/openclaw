import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import type { RealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import type { RealtimeVoiceTranscriptEntry } from "../talk/session-log-runtime.js";
import type { createMeetingAgentWaitingAudio } from "./realtime-agent-waiting-audio.js";
import { createMeetingTtsAudioStreamConverter } from "./realtime-audio-format.js";
import {
  formatMeetingAgentTtsResultLog,
  formatMeetingTranscriptSummaryLog,
  normalizeMeetingTtsPromptText,
} from "./realtime-engine-support.js";
import type { MeetingRealtimeEngineConfig, MeetingRuntimePlatform } from "./realtime-engine.js";
import type { createMeetingSpeechCancellation } from "./realtime-speech-cancellation.js";

export type MeetingSpeechUtterance = {
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
export function createMeetingSpeechOutput(params: {
  config: MeetingRealtimeEngineConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  platform: MeetingRuntimePlatform;
  meetingSessionId: string;
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
  waiting: ReturnType<typeof createMeetingAgentWaitingAudio>;
  speechCancellation: ReturnType<typeof createMeetingSpeechCancellation>;
  activeTtsAborts: Set<AbortController>;
  activeTtsReaders: Set<ReadableStreamDefaultReader<Uint8Array>>;
  writeOutputAudio: (
    audio: Buffer,
    firstChunk: boolean,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
}) {
  const {
    waiting,
    speechCancellation,
    activeTtsAborts,
    activeTtsReaders,
    writeOutputAudio,
    ttsAgentId,
    agentLogScope,
  } = params;
  let ttsQueue = Promise.resolve();
  let nextTtsPreparationGate = Promise.resolve();

  const createSpeechUtterance = (waitingTurn?: number): MeetingSpeechUtterance => ({
    generation: params.getOutputGeneration(),
    waitingGeneration: waiting.generation,
    waitingTurn,
    chunks: [],
    transcriptEntries: [],
    playbackStarted: false,
    finalized: false,
    failed: false,
  });

  const isCurrentSpeechUtterance = (utterance: MeetingSpeechUtterance) =>
    !params.isStopped() &&
    utterance.generation === params.getOutputGeneration() &&
    !utterance.finalized;

  const enqueueSpeechChunk = (text: string | undefined, utterance: MeetingSpeechUtterance) => {
    const harness = params.getHarness();
    const normalized = normalizeMeetingTtsPromptText(text);
    if (!normalized || !isCurrentSpeechUtterance(utterance)) {
      return;
    }
    utterance.chunks.push(normalized);
    const transcriptEntry = harness.recordTranscript("assistant", normalized);
    transcriptEntry.audioDelivery = "unplayed";
    utterance.transcriptEntries.push(transcriptEntry);
    params.logger.info(
      formatMeetingTranscriptSummaryLog(
        params.platform.logScope,
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
        try {
          if (!isCurrentSpeechUtterance(utterance) || controller.signal.aborted) {
            return;
          }
          if (!result.success || !result.audioStream || !result.sampleRate) {
            throw new Error(result.error ?? "TTS conversion failed");
          }
          params.logger.info(
            formatMeetingAgentTtsResultLog(params.platform.logScope, agentLogScope, result),
          );
          harness.ensureTurn();
          const reader = result.audioStream.getReader();
          activeTtsReaders.add(reader);
          let firstSegmentChunk = true;
          let firstUtteranceChunk = !utterance.playbackStarted;
          let bytesWritten = 0;
          const isCurrentPlayback = () =>
            isCurrentSpeechUtterance(utterance) && !controller.signal.aborted;
          try {
            const converter = createMeetingTtsAudioStreamConverter(
              result.sampleRate,
              params.config.chrome.audioFormat,
              result.outputFormat,
              params.platform.displayName,
            );
            for (;;) {
              if (!isCurrentPlayback()) {
                break;
              }
              const chunk = await reader.read();
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
              if (!(await writeOutputAudio(output, firstUtteranceChunk, isCurrentPlayback))) {
                break;
              }
              if (transcriptEntry.audioDelivery === "unplayed") {
                transcriptEntry.audioDelivery = "started";
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
            activeTtsReaders.delete(reader);
            reader.releaseLock();
            params.onActivity?.(params.getWaitingTurn() === undefined ? "listening" : "processing");
            if (utterance.waitingTurn !== undefined) {
              waiting.onOutputIdle(utterance.waitingTurn);
            }
          }
        } finally {
          allowNextPreparation();
          try {
            await result.release?.();
          } finally {
            activeTtsAborts.delete(controller);
          }
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
          `${params.platform.logScope} ${agentLogScope} TTS failed: ${formatErrorMessage(error)}`,
        );
      });
  };

  const finalizeSpeechUtterance = (utterance: MeetingSpeechUtterance, text: string | undefined) => {
    const harness = params.getHarness();
    const normalized = normalizeMeetingTtsPromptText(text);
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
      payload: { meetingSessionId: params.meetingSessionId, text: normalized },
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
        formatMeetingTranscriptSummaryLog(
          params.platform.logScope,
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
    createSpeechUtterance,
    isCurrentSpeechUtterance,
    enqueueSpeechChunk,
    finalizeSpeechUtterance,
    drain: () => ttsQueue,
  };
}
