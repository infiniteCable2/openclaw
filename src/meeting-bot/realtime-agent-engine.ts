// Shared STT plus agent-consult meeting engine.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import type { RealtimeTranscriptionSession } from "../realtime-transcription/provider-types.js";
import type { RealtimeVoiceAgentConsultResult } from "../talk/agent-consult-runtime.js";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../talk/realtime-session-harness.js";
import type { RealtimeVoiceTranscriptEntry } from "../talk/session-log-runtime.js";
import { createMeetingAgentWaitingAudio } from "./realtime-agent-waiting-audio.js";
import {
  createMeetingSttAudioConverter,
  createMeetingTtsAudioStreamConverter,
} from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import {
  formatMeetingAgentAudioModelLog,
  formatMeetingAgentTtsResultLog,
  formatMeetingTranscriptSummaryLog,
  meetingOutputBytesPerMs,
  MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS,
  MEETING_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
  MEETING_TRANSCRIPT_ECHO_LOOKBACK_MS,
  normalizeMeetingTtsPromptText,
  resolveMeetingRealtimeTranscriptionProvider,
  type MeetingAgentConsultParams,
  type MeetingRealtimeAudioEngineHandle,
  type MeetingRealtimeEngineConfig,
  type MeetingRuntimePlatform,
} from "./realtime-engine.js";
import { createMeetingBargeInGate } from "./realtime-output-gate.js";
import { createMeetingSpeechCancellation } from "./realtime-speech-cancellation.js";
import { createMeetingWaitingAudioPlayback, prepareMeetingWaitingAudio } from "./waiting-audio.js";

const MEETING_AGENT_READINESS_TIMEOUT_MS = 120_000;

export type MeetingAgentRealtimePreparation = {
  release(): Promise<void>;
};

export async function prepareMeetingAgentRealtimeEngine(params: {
  config: MeetingRealtimeEngineConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  ttsContext?: { agentId?: string; channelId?: string; accountId?: string };
  providers?: RealtimeTranscriptionProviderPlugin[];
  signal?: AbortSignal;
}): Promise<MeetingAgentRealtimePreparation> {
  const resolved = resolveMeetingRealtimeTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const timeoutSignal = AbortSignal.timeout(MEETING_AGENT_READINESS_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const ttsAgentId = params.ttsContext?.agentId ?? params.config.realtime.agentId;
  const sttPromise = resolved.provider.prepareSession?.({
    cfg: params.fullConfig,
    providerConfig: resolved.providerConfig,
    signal,
  });
  const ttsPromise = params.runtime.tts.prepareTextToSpeechTelephony({
    cfg: params.fullConfig,
    signal,
    ...(ttsAgentId ? { agentId: ttsAgentId } : {}),
    ...(params.ttsContext?.channelId ? { channelId: params.ttsContext.channelId } : {}),
    ...(params.ttsContext?.accountId ? { accountId: params.ttsContext.accountId } : {}),
  });
  const waitingAudioPromise = prepareMeetingWaitingAudio(
    params.config.realtime.waitingAudio,
    params.config.chrome.audioFormat,
  );
  const [sttResult, ttsResult, waitingAudioResult] = await Promise.allSettled([
    sttPromise,
    ttsPromise,
    waitingAudioPromise,
  ]);
  const releases: Array<() => void | Promise<void>> = [];
  if (sttResult.status === "fulfilled" && sttResult.value) {
    const sttPreparation = sttResult.value;
    releases.push(() => sttPreparation.release());
  }
  if (ttsResult.status === "fulfilled" && ttsResult.value.release) {
    releases.push(ttsResult.value.release);
  }
  const release = async () => {
    await Promise.allSettled(releases.splice(0).map(async (releaseResource) => releaseResource()));
  };
  if (sttResult.status === "rejected") {
    await release();
    throw sttResult.reason;
  }
  if (ttsResult.status === "rejected") {
    await release();
    throw ttsResult.reason;
  }
  if (waitingAudioResult.status === "rejected") {
    await release();
    throw waitingAudioResult.reason;
  }
  if (!ttsResult.value.success) {
    await release();
    throw new Error(ttsResult.value.error ?? "TTS telephony preparation failed");
  }
  return { release };
}

export async function startMeetingAgentRealtimeEngine(params: {
  config: MeetingRealtimeEngineConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  platform: MeetingRuntimePlatform;
  meetingSessionId: string;
  requesterSessionKey?: string;
  ttsContext?: { agentId?: string; channelId?: string; accountId?: string };
  logPrefix?: "node";
  transport: MeetingRealtimeAudioTransport;
  logger: RuntimeLogger;
  providers?: RealtimeTranscriptionProviderPlugin[];
  consultAgent: (params: MeetingAgentConsultParams) => Promise<RealtimeVoiceAgentConsultResult>;
}): Promise<MeetingRealtimeAudioEngineHandle> {
  type SpeechUtterance = {
    generation: number;
    waitingGeneration: number;
    chunks: string[];
    transcriptEntries: RealtimeVoiceTranscriptEntry[];
    playbackStarted: boolean;
    finalized: boolean;
    failed: boolean;
  };
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let sttSession: RealtimeTranscriptionSession | null = null;
  let realtimeReady = false;
  let ttsQueue = Promise.resolve();
  let nextTtsPreparationGate = Promise.resolve();
  const activeTtsAborts = new Set<AbortController>();
  const activeTtsReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let outputGeneration = 0;
  const agentLogScope = params.logPrefix ? `${params.logPrefix} agent` : "agent";
  const ttsAgentId = params.ttsContext?.agentId ?? params.config.realtime.agentId;
  const resolved = resolveMeetingRealtimeTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const sttInputFormat =
    resolved.provider.resolveInputAudioFormat?.(resolved.providerConfig) ?? "g711-ulaw-8khz";
  const sttAudioConverter = createMeetingSttAudioConverter(
    params.config.chrome.audioFormat,
    sttInputFormat,
  );
  const waitingAudio = await prepareMeetingWaitingAudio(
    params.config.realtime.waitingAudio,
    params.config.chrome.audioFormat,
  );
  const waitingAudioPlayback = createMeetingWaitingAudioPlayback({
    audio: waitingAudio,
    transport: params.transport,
    isStopped: () => stopped,
    onError: (error) => {
      params.logger.warn(
        `${params.platform.logScope} ${agentLogScope} waiting audio failed: ${formatErrorMessage(error)}`,
      );
    },
  });
  const waiting = createMeetingAgentWaitingAudio({
    playback: waitingAudioPlayback,
    isStopped: () => stopped,
    // Readers include the first-PCM drain; isolated input has no echo window.
    canStart: () => activeTtsReaders.size === 0 && !harness.isOutputPlaybackWindowActive(),
    onError: (error) => {
      params.logger.warn(
        `${params.platform.logScope} ${agentLogScope} waiting audio stop failed: ${formatErrorMessage(error)}`,
      );
    },
  });
  params.logger.info(
    formatMeetingAgentAudioModelLog({
      logScope: params.platform.logScope,
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      audioFormat: params.config.chrome.audioFormat,
    }),
  );

  const stop = async () => {
    if (stopped) {
      await stopPromise;
      return;
    }
    stopped = true;
    stopPromise = (async () => {
      for (const controller of activeTtsAborts) {
        controller.abort(new Error("Meeting audio output stopped"));
      }
      harness.close();
      try {
        sttSession?.close();
      } catch (error) {
        params.logger.debug?.(
          `${params.platform.logScope} ${agentLogScope} transcription bridge close ignored: ${formatErrorMessage(error)}`,
        );
      }
      harness.finishOutputAudio("stopped");
      harness.endTurn("stopped");
      harness.emit({
        type: "session.closed",
        final: true,
        payload: { meetingSessionId: params.meetingSessionId },
      });
      await waiting.stop();
      const transportStopPromise = params.transport.stop();
      await Promise.allSettled(
        [...activeTtsReaders].map(async (reader) => await reader.cancel().catch(() => undefined)),
      );
      await ttsQueue;
      try {
        await transportStopPromise;
      } finally {
        await params.transport.dispose();
      }
    })();
    await stopPromise;
  };

  const stopAfterFailure = (source: string) => {
    void stop().catch((error: unknown) => {
      params.logger.warn(
        `${params.platform.logScope} ${agentLogScope} ${source} cleanup failed: ${formatErrorMessage(error)}`,
      );
    });
  };

  const bargeInGate = createMeetingBargeInGate({
    transport: params.transport,
    isStopped: () => stopped,
    hasActiveOutput: () =>
      activeTtsAborts.size + activeTtsReaders.size > 0 || harness.isOutputPlaybackWindowActive(),
    onFailure: (error) => {
      params.logger.warn(
        `${params.platform.logScope} ${agentLogScope} output gate failed: ${formatErrorMessage(error)}`,
      );
      stopAfterFailure("output gate");
    },
  });

  const writeOutputAudio = async (audio: Buffer, firstChunk: boolean, isCurrent: () => boolean) => {
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
    if (!isCurrent()) {
      return false;
    }
    await params.transport.writeOutput(audio);
    return isCurrent();
  };

  const speechCancellation = createMeetingSpeechCancellation({
    harness: () => harness,
    activeTtsAborts,
    activeTtsReaders,
    bargeInGate,
    onPlaybackWindowCancelled: () => {
      outputGeneration += 1;
    },
  });

  const createSpeechUtterance = (): SpeechUtterance => ({
    generation: outputGeneration,
    waitingGeneration: waiting.generation,
    chunks: [],
    transcriptEntries: [],
    playbackStarted: false,
    finalized: false,
    failed: false,
  });

  const isCurrentSpeechUtterance = (utterance: SpeechUtterance) =>
    !stopped && utterance.generation === outputGeneration && !utterance.finalized;

  const removeProvisionalTranscriptEntries = (utterance: SpeechUtterance) => {
    for (const entry of utterance.transcriptEntries) {
      const index = harness.transcript.indexOf(entry);
      if (index >= 0) {
        harness.transcript.splice(index, 1);
      }
    }
    utterance.transcriptEntries.length = 0;
  };

  const enqueueSpeechChunk = (text: string | undefined, utterance: SpeechUtterance) => {
    const normalized = normalizeMeetingTtsPromptText(text);
    if (!normalized || !isCurrentSpeechUtterance(utterance)) {
      return;
    }
    utterance.chunks.push(normalized);
    const transcriptEntry = harness.recordTranscript("assistant", normalized);
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
        if (!isCurrentSpeechUtterance(utterance) || controller.signal.aborted) {
          await result.release?.();
          activeTtsAborts.delete(controller);
          allowNextPreparation();
          return;
        }
        if (!result.success || !result.audioStream || !result.sampleRate) {
          activeTtsAborts.delete(controller);
          allowNextPreparation();
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
              // A stream handle is not audible output. Keep the waiting loop
              // through synthesis and buffering, then drain before each segment resumes PCM.
              await waiting.stop();
            }
            if (!(await writeOutputAudio(output, firstUtteranceChunk, isCurrentPlayback))) {
              break;
            }
            if (firstUtteranceChunk) {
              utterance.playbackStarted = true;
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
        } finally {
          allowNextPreparation();
          activeTtsReaders.delete(reader);
          reader.releaseLock();
          waiting.onOutputIdle();
          await result.release?.();
          activeTtsAborts.delete(controller);
        }
      })
      .catch((error: unknown) => {
        if (!isCurrentSpeechUtterance(utterance)) {
          return;
        }
        utterance.failed = true;
        utterance.finalized = true;
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

  const finalizeSpeechUtterance = (utterance: SpeechUtterance, text: string | undefined) => {
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
    ttsQueue = ttsQueue.then(() => {
      if (!isCurrentSpeechUtterance(utterance) || utterance.failed) {
        return;
      }
      removeProvisionalTranscriptEntries(utterance);
      harness.recordTranscript("assistant", normalized);
      params.logger.info(
        formatMeetingTranscriptSummaryLog(
          params.platform.logScope,
          `${agentLogScope} assistant`,
          normalized,
        ),
      );
      harness.finishOutputAudio("completed");
      harness.endTurn();
      utterance.finalized = true;
    });
  };

  const abortSpeechUtterance = (utterance: SpeechUtterance) => {
    if (!isCurrentSpeechUtterance(utterance)) {
      return;
    }
    outputGeneration += 1;
    utterance.finalized = true;
    waiting.stopInBackground(utterance.waitingGeneration);
    speechCancellation.cancelActiveSpeech();
    harness.finishOutputAudio("cancelled");
    harness.endTurn("cancelled");
  };

  const enqueueSpeakText = (text: string | undefined) => {
    const utterance = createSpeechUtterance();
    enqueueSpeechChunk(text, utterance);
    finalizeSpeechUtterance(utterance, text);
  };

  // The closures above only run after harness creation; they capture this later `const`.
  // Annotated because the consult closure references harness inside its own initializer.
  const harness: RealtimeVoiceSessionHarness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: `${params.platform.sessionIdPrefix}:${params.meetingSessionId}:agent`,
      mode: "stt-tts",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: resolved.provider.id,
      turnIdPrefix: `${params.platform.sessionIdPrefix}:${params.meetingSessionId}:turn`,
    },
    talkPayloads: {
      turnStarted: () => ({ meetingSessionId: params.meetingSessionId }),
      turnEnded: () => ({ meetingSessionId: params.meetingSessionId }),
      inputAudioDelta: (audio) => ({
        meetingSessionId: params.meetingSessionId,
        bytes: audio.byteLength,
      }),
      outputAudioStarted: () => ({ meetingSessionId: params.meetingSessionId }),
      outputAudioDelta: (audio) => ({
        meetingSessionId: params.meetingSessionId,
        bytes: audio.byteLength,
      }),
      outputAudioDone: () => ({ meetingSessionId: params.meetingSessionId }),
    },
    echoSuppression: params.transport.inputAudioIsolated
      ? undefined
      : {
          bytesPerMs: meetingOutputBytesPerMs(params.config.chrome.audioFormat),
          tailMs: MEETING_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
          transcriptLookbackMs: MEETING_TRANSCRIPT_ECHO_LOOKBACK_MS,
          suppressInputDuringOutput: params.transport.supportsFullDuplexInput !== true,
        },
    talkback: {
      debounceMs:
        resolved.provider.transcriptGranularity === "utterance"
          ? 0
          : MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS,
      logger: params.logger,
      logPrefix: `${params.platform.logScope} ${agentLogScope}`,
      responseStyle: "Brief, natural spoken answer for a live meeting.",
      fallbackText: "I hit an error while checking that. Please try again.",
      consult: async ({ question, responseStyle, signal }) => {
        waiting.schedule();
        const utterance = createSpeechUtterance();
        const result = await params.consultAgent({
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: { question, responseStyle },
          transcript: harness.transcript,
          abortSignal: signal,
          ...(params.config.realtime.responseStreaming === "sentence"
            ? {
                onSpeakableText: (event) => {
                  if (event.type === "chunk") {
                    enqueueSpeechChunk(event.text, utterance);
                  } else if (event.type === "done") {
                    finalizeSpeechUtterance(utterance, event.text);
                  } else {
                    abortSpeechUtterance(utterance);
                  }
                },
              }
            : {}),
        });
        if (
          !result.text.trim() &&
          utterance.chunks.length === 0 &&
          isCurrentSpeechUtterance(utterance)
        ) {
          await waiting.stop(utterance.waitingGeneration);
        }
        return result;
      },
      deliver: enqueueSpeakText,
    },
  });

  params.transport.onFatal(() => {
    stopAfterFailure("audio transport");
  });
  // onFatal replays a pre-registration failure synchronously; abort before creating a
  // provider session that the already-completed stop() could never close.
  if (stopped) {
    throw new Error(
      `${params.platform.displayName} audio transport failed before transcription provider setup`,
    );
  }

  try {
    sttSession = resolved.provider.createSession({
      cfg: params.fullConfig,
      providerConfig: resolved.providerConfig,
      inputAudioFormat: sttInputFormat,
      onSpeechStart: () => {
        if (stopped) {
          return;
        }
        waiting.onSpeechStart();
      },
      onSpeechActivity: bargeInGate.onSpeechActivity,
      onProcessing: (event) => {
        waiting.onProcessing(event);
        // An energy-only onset can be echo or noise. Keep already-started speech
        // intact until the transcription provider has confirmed actual speech.
        if (!stopped && event.state === "speech-confirmed") {
          speechCancellation.cancelActivePlayback();
        }
        bargeInGate.onProcessing(event);
      },
      onTranscript: (text, context) => {
        const trimmed = text.trim();
        if (!trimmed || stopped) {
          return;
        }
        const assistantEcho = harness.isLikelyAssistantEchoTranscript(trimmed);
        waiting.onTranscript(context, assistantEcho);
        if (!assistantEcho) {
          // Before the first output byte, only an accepted final transcript can
          // discard prepared speech. Delayed assistant echoes are not caller turns.
          outputGeneration += 1;
          if (!speechCancellation.cancelForConfirmedTurn()) {
            bargeInGate.release(context?.utteranceId);
          }
        } else {
          bargeInGate.release(context?.utteranceId);
        }
        // Shipped Meet semantics keep assistant echoes in transcript history and events.
        // Echo suppression only prevents the recorded line from entering talkback.
        const turnId = harness.ensureTurn();
        harness.emit({
          type: "input.audio.committed",
          turnId,
          final: true,
          payload: { meetingSessionId: params.meetingSessionId },
        });
        harness.emit({
          type: "transcript.done",
          turnId,
          final: true,
          payload: { meetingSessionId: params.meetingSessionId, text: trimmed, role: "user" },
        });
        harness.recordTranscript("user", trimmed);
        params.logger.info(
          formatMeetingTranscriptSummaryLog(
            params.platform.logScope,
            `${agentLogScope} user`,
            trimmed,
          ),
        );
        if (assistantEcho) {
          params.logger.info(
            formatMeetingTranscriptSummaryLog(
              params.platform.logScope,
              `${agentLogScope} ignored assistant echo transcript`,
              trimmed,
            ),
          );
          return;
        }
        harness.talkback?.enqueue(trimmed);
      },
      onError: (error) => {
        params.logger.warn(
          `${params.platform.logScope} ${agentLogScope} transcription bridge failed: ${formatErrorMessage(error)}`,
        );
        harness.emit({
          type: "session.error",
          final: true,
          payload: { meetingSessionId: params.meetingSessionId, error: formatErrorMessage(error) },
        });
        stopAfterFailure("transcription bridge");
      },
    });

    harness.emit({
      type: "session.started",
      payload: { meetingSessionId: params.meetingSessionId, provider: resolved.provider.id },
    });
    // Drain transport input while connect() is pending so the capture pipe never backpressures;
    // chunks before session.ready are dropped instead of arriving later as a stale burst.
    params.transport.startInput((audio) => {
      if (stopped || !realtimeReady || audio.byteLength === 0) {
        return;
      }
      if (!harness.recordInputAudio(audio)) {
        return;
      }
      sttSession?.sendAudio(sttAudioConverter.process(audio));
    });

    await sttSession.connect();
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      params.logger.debug?.(
        `${params.platform.logScope} ${agentLogScope} failed-start cleanup ignored: ${formatErrorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
  if (stopped) {
    throw new Error(
      `${params.platform.displayName} audio transport stopped during transcription provider setup`,
    );
  }
  realtimeReady = true;
  harness.emit({
    type: "session.ready",
    payload: { meetingSessionId: params.meetingSessionId },
  });

  return {
    providerId: resolved.provider.id,
    speak: enqueueSpeakText,
    getHealth: () => ({
      ...harness.getHealth({
        providerConnected: sttSession?.isConnected() ?? false,
        realtimeReady,
      }),
      ...params.transport.getHealth?.(),
      bridgeClosed: stopped,
    }),
    stop,
  };
}
