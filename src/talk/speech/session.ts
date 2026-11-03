// Shared transport-neutral STT, native agent admission, and speech delivery owner.
import { resolveAgentLanguage } from "../../agents/identity.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { RealtimeTranscriptionSession } from "../../realtime-transcription/provider-types.js";
import { resolveUserMessages } from "../../shared/user-messages.js";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../realtime-session-harness.js";
import { publishTalkConnectionPresentation } from "../session-registry.js";
import { createSpeechActivity } from "./activity.js";
import { createSpeechCancellation } from "./cancellation.js";
import { playSpeechGreeting } from "./greeting.js";
import { createSpeechInputOnset } from "./input-onset.js";
import { admitLegacySpeechInput } from "./legacy-input.js";
import { bindNativeSpeechControl } from "./native-control.js";
import { createNativeSpeechInput } from "./native-input.js";
import { createSpeechBargeInGate } from "./output-gate.js";
import { createSpeechOutput, type SpeechUtterance } from "./output.js";
import { createSpeechSessionControls } from "./session-controls.js";
import { createSpeechInputMetadata } from "./session-input-identity.js";
import {
  createSpeechSessionInputObservers,
  type SpeechInputOnsetSnapshot,
} from "./session-input-onset.js";
import { createSpeechSessionInput, createSpeechTranscriptionInput } from "./session-input.js";
import { createSpeechSessionLifecycle } from "./session-lifecycle.js";
import type { SpeechStreamCancellation } from "./stream-cleanup.js";
import {
  buildSpeechTranscriptionFailureEvent,
  formatSpeechAgentAudioModelLog,
  formatSpeechTranscriptSummaryLog,
  speechOutputBytesPerMs,
  resolveSpeechTranscriptionProvider,
} from "./support.js";
import {
  SPEECH_AGENT_TRANSCRIPT_DEBOUNCE_MS,
  SPEECH_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
  SPEECH_TRANSCRIPT_ECHO_LOOKBACK_MS,
  type SpeechActiveConsult,
  type SpeechSessionHandle,
  type SpeechSessionStartParams,
} from "./types.js";
import { createSpeechVideoInput } from "./video-input.js";
import { createSpeechWaitingAudioPlayback, prepareSpeechWaitingAudio } from "./waiting-audio.js";
import { createSpeechWaitingController } from "./waiting-controller.js";

export async function startSpeechSession(
  params: SpeechSessionStartParams,
): Promise<SpeechSessionHandle> {
  params.signal?.throwIfAborted();
  const language = resolveAgentLanguage(params.fullConfig, params.config.agentId ?? "");
  const messages = resolveUserMessages(language);
  let stopped = false;
  const video = createSpeechVideoInput(params.config.video);
  const inputs = createSpeechInputMetadata(video, params.sessionId);
  let sttSession: RealtimeTranscriptionSession | null = null;
  let realtimeReady = false;
  let releaseConnectionPresentation: (() => void) | undefined;
  const activeTtsAborts = new Set<AbortController>();
  const activeTtsReaders = new Set<SpeechStreamCancellation>();
  let greetingPlayback: Promise<void> | undefined;
  let outputGeneration = 0;
  const activity = createSpeechActivity({
    emit: (event) => {
      harness.emit(event);
    },
    getGeneration: () => outputGeneration,
  });
  let waitingOutput: { generation: number; outputGeneration: number } | undefined;
  let outputTurnId: string | undefined;
  let greetingPending = params.initialGreeting !== undefined;
  let currentWaitingTurn: number | undefined;
  // Native runs own admission; the session only serializes acknowledgments and audio generations.
  let activeConsult: SpeechActiveConsult | undefined;
  let responseQuestion: string | undefined;
  const inputOnset = createSpeechInputOnset<SpeechInputOnsetSnapshot>();
  const agentLogScope = params.logPrefix ? `${params.logPrefix} agent` : "agent";
  const resolved = resolveSpeechTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const waitingAudio = await prepareSpeechWaitingAudio(
    params.config.waitingAudio,
    params.config.audioFormat,
  );
  params.signal?.throwIfAborted();
  const input = createSpeechSessionInput(params.transport);
  const assertStarting = () => {
    params.signal?.throwIfAborted();
    if (stopped) {
      throw new Error(
        `${params.surface.displayName} audio transport stopped during provider setup`,
      );
    }
  };
  const transcriptionInput = createSpeechTranscriptionInput({
    inputEndMode: params.config.inputEndMode,
    inputAudioFormat: params.config.inputAudioFormat ?? params.config.audioFormat,
    transcription: resolved,
    getSession: () => sttSession,
    isReady: () => realtimeReady,
    assertCurrent: assertStarting,
    acceptAudio: (audio) => harness.recordInputAudio(audio),
    onCaptureStarted: activity.captureStarted,
    onAudio: activity.audio,
    onCaptureEnded: activity.captureEnded,
  });
  const waiting = createSpeechWaitingController({
    playback: createSpeechWaitingAudioPlayback({
      audio: waitingAudio,
      transport: params.transport,
      isStopped: () => stopped,
      onActivity(state, generation) {
        if (state === "streaming") {
          waitingOutput = { generation, outputGeneration };
        }
        if (waitingOutput?.generation === generation) {
          activity.output(waitingOutput.outputGeneration, state, "waiting");
        }
      },
      onError: (error) => {
        params.logger.warn(
          `${params.surface.logScope} ${agentLogScope} waiting audio failed: ${formatErrorMessage(error)}`,
        );
      },
    }),
    isStopped: () => stopped,
    // Full-duplex sinks can resume music after estimated TTS playout; the longer
    // echo-suppression tail stays independent, and a paused gate adds a drain hold.
    canStart: () =>
      // A reader may be preparing a successor, not delivering audible output.
      !speechOutput.isHandoffPending() &&
      bargeInGate.canResumeWaitingAudio() &&
      !(params.transport.supportsFullDuplexInput === true
        ? harness.isOutputPlaybackActive()
        : harness.isOutputPlaybackWindowActive()),
    resumeDelayMs: waitingAudio?.resumeDelayMs ?? 800,
    onError: (error) => {
      params.logger.warn(
        `${params.surface.logScope} ${agentLogScope} waiting audio stop failed: ${formatErrorMessage(error)}`,
      );
    },
  });
  params.logger.info(
    formatSpeechAgentAudioModelLog({
      logScope: params.surface.logScope,
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      audioFormat: params.config.audioFormat,
    }),
  );
  const finishWaitingTurn = (turn: number) => {
    waiting.onTurnFinished(turn);
    if (currentWaitingTurn === turn) {
      currentWaitingTurn = undefined;
    }
  };

  const lifecycle = createSpeechSessionLifecycle({
    logger: params.logger,
    logScope: `${params.surface.logScope} ${agentLogScope}`,
    fence() {
      stopped = true;
      activity.close();
      releaseConnectionPresentation?.();
      releaseConnectionPresentation = undefined;
      video.close();
      realtimeReady = false;
      inputOnset.close();
      speechCancellation.markInterruptedTranscript();
      for (const controller of activeTtsAborts) {
        controller.abort(new Error("Speech audio output stopped"));
      }
      harness.close();
      harness.finishOutputAudio("stopped");
      harness.endTurn("stopped");
    },
    closeTranscription: () => transcriptionInput.close(),
    stopWaiting: () => waiting.stop(),
    drainOutput: () => speechOutput.stopAndDrain(greetingPlayback),
    stopTransport: () => input.stop(),
    disposeTransport: () => params.transport.dispose(),
    connectionPreparation: params.connectionPreparation,
    publishClosed: () => {
      harness.emit({
        type: "session.closed",
        final: true,
        payload: { sessionId: params.sessionId },
      });
    },
  });
  const { stop, stopAfterFailure } = lifecycle;

  const bargeInGate = createSpeechBargeInGate({
    transport: params.transport,
    isStopped: () => stopped,
    hasActiveOutput: () =>
      activeTtsAborts.size + activeTtsReaders.size > 0 || harness.isOutputPlaybackWindowActive(),
    onFailure: (error) => lifecycle.fail("output gate", error),
  });

  const speechCancellation = createSpeechCancellation({
    harness: () => harness,
    activeTtsAborts,
    activeTtsReaders,
    bargeInGate,
  });

  const speechOutput = createSpeechOutput({
    config: params.config,
    fullConfig: params.fullConfig,
    runtime: params.runtime,
    surface: params.surface,
    sessionId: params.sessionId,
    ttsContext: params.ttsContext,
    ttsAgentId: params.ttsContext?.agentId ?? params.config.agentId,
    agentLogScope,
    logger: params.logger,
    onActivity: params.onActivity,
    onOutput: activity.output,
    getHarness: () => harness,
    isStopped: () => stopped,
    getOutputGeneration: () => outputGeneration,
    getWaitingTurn: () => currentWaitingTurn,
    finishWaitingTurn,
    waitForInput: () => inputOnset.wait(),
    waiting,
    speechCancellation,
    activeTtsAborts,
    activeTtsReaders,
    transport: params.transport,
    onOutputTurn: (turnId) => {
      outputTurnId = turnId;
    },
  });
  const abortSpeechUtterance = (utterance: SpeechUtterance) => {
    if (!speechOutput.isCurrentSpeechUtterance(utterance)) {
      return;
    }
    outputGeneration += 1;
    activity.output(outputGeneration, "idle");
    speechCancellation.markInterruptedTranscript();
    utterance.finalized = true;
    if (utterance.waitingTurn !== undefined) {
      finishWaitingTurn(utterance.waitingTurn);
    }
    waiting.stopInBackground(utterance.waitingGeneration);
    speechCancellation.cancelActiveSpeech();
    harness.finishOutputAudio("cancelled");
    harness.endTurn("cancelled");
    params.onActivity?.("listening");
  };

  // Annotate the self-referencing harness; earlier closures run only after construction.
  const harness: RealtimeVoiceSessionHarness = createRealtimeVoiceSessionHarness({
    onTalkEvent: params.onTalkEvent,
    onInputAvailabilityChanged: activity.inputAvailable,
    talk: {
      sessionId: params.sessionId,
      mode: "stt-tts",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: resolved.provider.id,
      turnIdPrefix: `${params.surface.sessionIdPrefix}:${params.sessionId}:turn`,
    },
    talkPayloads: {
      turnStarted: () => ({ sessionId: params.sessionId }),
      turnEnded: () => ({ sessionId: params.sessionId }),
      inputAudioDelta: (audio) => ({
        sessionId: params.sessionId,
        bytes: audio.byteLength,
      }),
      outputAudioStarted: () => ({ sessionId: params.sessionId }),
      outputAudioDelta: (audio) => ({
        sessionId: params.sessionId,
        bytes: audio.byteLength,
      }),
      outputAudioDone: () => ({ sessionId: params.sessionId }),
    },
    echoSuppression: params.transport.inputAudioIsolated
      ? undefined
      : {
          bytesPerMs: speechOutputBytesPerMs(params.config.audioFormat),
          tailMs:
            (params.config.echoSuppressionTailSeconds ??
              SPEECH_OUTPUT_ECHO_SUPPRESSION_TAIL_MS / 1_000) * 1_000,
          transcriptLookbackMs: SPEECH_TRANSCRIPT_ECHO_LOOKBACK_MS,
          suppressInputDuringOutput: params.transport.supportsFullDuplexInput !== true,
        },
    talkback: params.nativeInput
      ? undefined
      : {
          onActivity: activity.legacyWork,
          debounceMs:
            resolved.provider.transcriptGranularity === "utterance"
              ? 0
              : SPEECH_AGENT_TRANSCRIPT_DEBOUNCE_MS,
          logger: params.logger,
          logPrefix: `${params.surface.logScope} ${agentLogScope}`,
          responseStyle: "Brief, natural spoken answer for a live conversation.",
          fallbackText: "I hit an error while checking that. Please try again.",
          ...inputs.queueOptions,
          consult: async ({ question, metadata, responseStyle, signal }) => {
            params.onActivity?.("processing");
            const waitingTurn = waiting.onTurnStarted();
            currentWaitingTurn = waitingTurn;
            const utterance = speechOutput.createSpeechUtterance(waitingTurn);
            const consult: NonNullable<typeof activeConsult> = {
              admissions: Promise.resolve(),
              adoptedGeneration: outputGeneration,
              unconfirmed: false,
              followupOnly: false,
              question,
              releaseVideo: new Set(),
            };
            activeConsult = consult;
            responseQuestion = question;
            let failure: { error: unknown } | undefined;
            const { snapshot, input: conversationInput } = inputs.read(metadata);
            if (snapshot) {
              consult.releaseVideo.add(snapshot.release);
            }
            const result: Awaited<ReturnType<typeof params.consultAgent>> = await Promise.resolve()
              .then(async () => {
                const visualInput = await video.prepare(snapshot, signal);
                return params.consultAgent({
                  sessionId: params.sessionId,
                  ...conversationInput,
                  requesterSessionKey: params.requesterSessionKey,
                  args: {
                    question,
                    responseStyle,
                    ...(visualInput.context ? { context: visualInput.context } : {}),
                  },
                  ...(visualInput.images.length ? { images: visualInput.images } : {}),
                  ...(video.source ? { toolBindings: { video_inspect: video.source } } : {}),
                  transcript: harness.transcript,
                  abortSignal: signal,
                  onRunControl: (control) => {
                    consult.control = control;
                  },
                  waitForPendingInput: (runSignal) =>
                    inputOnset.waitForChange((onset) => onset.consult === consult, runSignal),
                  ...(params.config.responseStreaming === "sentence"
                    ? {
                        onSpeakableText: (event) => {
                          if (event.type === "chunk") {
                            speechOutput.enqueueSpeechPart(event, utterance);
                          } else if (event.type === "done") {
                            speechOutput.finalizeSpeechUtterance(utterance, event.text);
                          } else {
                            abortSpeechUtterance(utterance);
                          }
                        },
                      }
                    : {}),
                });
              })
              .catch((error: unknown) => {
                finishWaitingTurn(waitingTurn);
                failure = { error };
                return { text: "" };
              });
            // Wait for onset resolution, including input after native retirement, without reviving that run.
            // Native steering confirmation may finish just after the run. Do not
            // release talkback or speak a result before every admitted input settles.
            while (true) {
              await inputOnset.wait();
              const admissions = consult.admissions;
              await admissions;
              if (admissions === consult.admissions && !inputOnset.hasPending()) {
                break;
              }
            }
            for (const release of consult.releaseVideo) {
              release();
            }
            consult.releaseVideo.clear();
            if (activeConsult === consult) {
              activeConsult = undefined;
            }
            if (stopped) {
              return { text: "" };
            }
            if (consult.unconfirmed) {
              speechCancellation.recordUnplayedAnswer(utterance.transcriptEntries, result.text);
              waiting.onTurnFinished(waitingTurn);
              return {
                text: "I couldn't confirm your additional request. Please check before asking me to repeat an action.",
              };
            }
            if (failure && !consult.followupOnly) {
              throw failure.error;
            }
            if (utterance.generation !== outputGeneration) {
              if (consult.adoptedGeneration === outputGeneration) {
                // The latest native answer consolidates wanted results and respects
                // corrections. Never replay old PCM or preceding answer payloads.
                currentWaitingTurn = waitingTurn;
                if (result.utterances?.length) {
                  const currentUtterance = speechOutput.createSpeechUtterance(waitingTurn);
                  speechOutput.enqueueSpeechResult(result, currentUtterance);
                  return { ...result, delivered: true };
                }
                return { ...result, delivered: false };
              }
              speechCancellation.recordUnplayedAnswer(utterance.transcriptEntries, result.text);
              // A later input was not adopted by this run. Preserve its answer as a
              // delivery fact for the next consult without resurrecting stale speech.
              finishWaitingTurn(waitingTurn);
              return { ...result, text: "" };
            }
            if (
              !result.text.trim() &&
              utterance.chunks.length === 0 &&
              speechOutput.isCurrentSpeechUtterance(utterance)
            ) {
              await waiting.stop(utterance.waitingGeneration);
              finishWaitingTurn(waitingTurn);
            }
            if (!result.delivered && result.utterances?.length) {
              speechOutput.enqueueSpeechResult(result, utterance);
              return { ...result, delivered: true };
            }
            return result;
          },
          deliver: speechOutput.enqueueSpeakText,
        },
  });

  const nativeInput = params.nativeInput
    ? createNativeSpeechInput({
        language,
        dispatch: params.nativeInput,
        session: params,
        inputs,
        video,
        output: speechOutput,
        abortSpeechUtterance,
        isStopped: () => stopped,
        getGeneration: () => outputGeneration,
        onWork: activity.work,
        startWaiting() {
          params.onActivity?.("processing");
          const turn = waiting.onTurnStarted();
          currentWaitingTurn = turn;
          return turn;
        },
        finishWaiting: finishWaitingTurn,
        waitForInput: (run, signal) =>
          inputOnset.waitForChange((onset) => onset.nativeRun === run, signal),
        recordUnplayed: (utterance, text) =>
          speechCancellation.recordUnplayedAnswer(utterance.transcriptEntries, text),
        onFailure(error) {
          params.logger.warn(
            `${params.surface.logScope} native speech input failed: ${formatErrorMessage(error)}`,
          );
          if (!stopped) {
            harness.emit({
              type: "session.error",
              final: true,
              payload: { sessionId: params.sessionId, error: messages.voiceInputFailed },
            });
          }
        },
      })
    : undefined;

  const handle: SpeechSessionHandle = {
    providerId: resolved.provider.id,
    get supportsInputEnd() {
      return transcriptionInput.supportsInputEnd;
    },
    finishInput: (options) => transcriptionInput.finishInput(options),
    publishActivity: activity.publish,
    speak: speechOutput.enqueueSpeakText,
    ...createSpeechSessionControls({
      harness,
      cancellation: speechCancellation,
      getConsult: () => activeConsult,
      isStopped: () => stopped,
      getOutputGeneration: () => outputGeneration,
      getOutputTurnId: () => outputTurnId,
      hasOutput: () =>
        activeTtsAborts.size + activeTtsReaders.size > 0 ||
        speechOutput.hasPendingOutput() ||
        harness.isOutputPlaybackWindowActive() ||
        greetingPending,
      invalidateOutput: () => {
        outputGeneration++;
        activity.output(outputGeneration, "idle");
        greetingPending = false;
      },
    }),
    getHealth: () => ({
      ...harness.getHealth({
        providerConnected: sttSession?.isConnected() ?? false,
        realtimeReady,
      }),
      ...params.transport.getHealth?.(),
      bridgeClosed: lifecycle.isTranscriptionClosed(),
    }),
    stop,
  };
  if (nativeInput) {
    bindNativeSpeechControl(handle, nativeInput.control);
  }
  try {
    if (params.connectionPresentation) {
      releaseConnectionPresentation = publishTalkConnectionPresentation(params.sessionId, {
        ...params.connectionPresentation,
        state: () => (stopped ? "closed" : realtimeReady ? "ready" : "preparing"),
      });
    }
    params.onSession?.(handle);
    params.transport.onFatal(() => {
      stopAfterFailure("audio transport");
    });
    // onFatal may synchronously replay a failure before provider construction.
    assertStarting();
    sttSession = resolved.provider.createSession({
      cfg: params.fullConfig,
      providerConfig: resolved.providerConfig,
      inputAudioFormat: transcriptionInput.providerAudioFormat,
      inputEndMode: params.config.inputEndMode ?? "server",
      onSpeechStart: () => {
        if (stopped) {
          return;
        }
        waiting.onSpeechStart();
        greetingPending = false;
        currentWaitingTurn = undefined;
      },
      ...createSpeechSessionInputObservers({
        isStopped: () => stopped,
        onActivity: params.onActivity,
        observeActivity: activity.speechActivity,
        observeProcessing: activity.processing,
        onFailure: () => stopAfterFailure("speech onset lifecycle"),
        video,
        inputOnset,
        bargeInGate,
        waiting,
        harness,
        speechCancellation,
        getConsult: () => activeConsult,
        getNativeInput: () => nativeInput,
        getResponseQuestion: () => responseQuestion,
        activeTtsAborts,
        activeTtsReaders,
      }),
      onTranscript: (text, context) => {
        const reservation = inputOnset.claim(context?.utteranceId);
        const onset = reservation?.value;
        const trimmed = text.trim();
        if (!trimmed || stopped) {
          video.settle(context?.utteranceId);
          reservation?.release();
          return;
        }
        const assistantEcho = harness.isLikelyAssistantEchoTranscript(trimmed);
        waiting.onTranscript(context, assistantEcho);
        if (!assistantEcho) {
          // Before the first output byte, only an accepted final transcript can
          // discard prepared speech. Delayed assistant echoes are not caller turns.
          outputGeneration += 1;
          activity.output(outputGeneration, "idle");
          if (onset) {
            speechCancellation.markInterruptedTranscript(onset.interruptedEntries);
          }
          speechCancellation.markInterruptedTranscript();
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
          payload: { sessionId: params.sessionId },
        });
        harness.emit({
          type: "transcript.done",
          turnId,
          final: true,
          payload: { sessionId: params.sessionId, text: trimmed, role: "user" },
        });
        const userEntry = harness.recordTranscript("user", trimmed);
        if (onset && !assistantEcho) {
          userEntry.speechStart = onset.speechStart;
        }
        params.logger.info(
          formatSpeechTranscriptSummaryLog(
            params.surface.logScope,
            `${agentLogScope} user`,
            trimmed,
          ),
        );
        if (assistantEcho) {
          activity.transcript(context?.utteranceId);
          video.settle(context?.utteranceId);
          reservation?.release();
          params.logger.info(
            formatSpeechTranscriptSummaryLog(
              params.surface.logScope,
              `${agentLogScope} ignored assistant echo transcript`,
              trimmed,
            ),
          );
          return;
        }
        const metadata = inputs.capture(onset?.startedAtMs, context?.utteranceId);
        if (nativeInput) {
          nativeInput.enqueue({
            text: trimmed,
            metadata,
            onsetRun: onset?.nativeRun,
            onsetPlayback: onset?.nativePlayback,
            hasOnset: onset !== undefined,
            onAccepted: reservation?.release,
          });
          activity.transcript(context?.utteranceId);
          return;
        }
        admitLegacySpeechInput({
          text: trimmed,
          metadata,
          onsetConsult: onset?.consult,
          hasOnset: onset !== undefined,
          getConsult: () => activeConsult,
          generation: outputGeneration,
          isStopped: () => stopped,
          enqueue: () => harness.talkback?.enqueue(trimmed, metadata) ?? false,
          releaseOnset: reservation?.release,
          video,
          onUnconfirmed() {
            params.logger.warn(
              `${params.surface.logScope} ${agentLogScope} input steering confirmation failed`,
            );
          },
        });
        activity.transcript(context?.utteranceId);
      },
      onError: (error) => {
        params.logger.warn(
          `${params.surface.logScope} ${agentLogScope} transcription bridge failed: ${formatErrorMessage(error)}`,
        );
        harness.emit(buildSpeechTranscriptionFailureEvent(params.sessionId, error, language));
        stopAfterFailure("transcription bridge");
      },
    });

    if (params.config.inputEndMode === "client" && !transcriptionInput.supportsInputEnd) {
      throw new Error("Client-ended transcription session must implement finishInput");
    }
    harness.emit({
      type: "session.started",
      payload: { sessionId: params.sessionId, provider: resolved.provider.id },
    });
    activity.publish();
    // Drain transport input while connect() is pending so the capture pipe never backpressures;
    // chunks before session.ready are dropped instead of arriving later as a stale burst.
    await input.start(
      (audio, metadata) => {
        if (stopped || !realtimeReady || audio.byteLength === 0) {
          return;
        }
        transcriptionInput.sendAudio(audio, metadata);
      },
      assertStarting,
      () => video.start(params.transport, assertStarting),
    );

    const session = sttSession;
    await racePromiseWithAbortSignal(() => session.connect(), params.signal);
    assertStarting();
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Speech session setup and resource cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
  realtimeReady = true;
  activity.inputAvailable(harness.isInputAudioAvailable());
  activity.connection("ready");
  harness.emit({
    type: "session.ready",
    payload: { sessionId: params.sessionId },
  });

  if (params.initialGreeting) {
    const greeting = params.initialGreeting;
    const generation = outputGeneration;
    activity.output(generation, "preparing", "greeting");
    greetingPlayback = playSpeechGreeting({
      greeting,
      transport: params.transport,
      harness,
      sessionId: params.sessionId,
      activeTtsAborts,
      isCurrent: () => !stopped && outputGeneration === generation,
      canStart: () => greetingPending,
      onStarted: () => {
        greetingPending = false;
      },
      writeOutputAudio: (audio, firstChunk, isCurrent) =>
        speechOutput.writeOutputAudio(audio, firstChunk, isCurrent, () => {
          activity.output(generation, "streaming", "greeting");
        }),
    })
      .finally(() => activity.output(generation, "submitted", "greeting"))
      .catch((error: unknown) => lifecycle.fail("greeting playback", error));
  }

  return handle;
}
