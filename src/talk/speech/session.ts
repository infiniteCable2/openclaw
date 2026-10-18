// Shared transport-neutral STT, native agent admission, and speech delivery owner.
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { RealtimeTranscriptionSession } from "../../realtime-transcription/provider-types.js";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../realtime-session-harness.js";
import type { RealtimeVoiceTranscriptEntry } from "../session-log-runtime.js";
import { publishTalkConnectionPresentation } from "../session-registry.js";
import { createSpeechSttAudioConverter } from "./audio-format.js";
import { createSpeechCancellation } from "./cancellation.js";
import { playSpeechGreeting } from "./greeting.js";
import { createSpeechInputOnset } from "./input-onset.js";
import { admitLegacySpeechInput } from "./legacy-input.js";
import { createNativeSpeechInput } from "./native-input.js";
import { createSpeechBargeInGate } from "./output-gate.js";
import { createSpeechOutput, type SpeechUtterance } from "./output.js";
import type { SpeechPlaybackSnapshot } from "./playback-observation.js";
import { createSpeechSessionControls } from "./session-controls.js";
import { createSpeechInputMetadata } from "./session-input-identity.js";
import { createSpeechSessionInput } from "./session-input.js";
import { createSpeechSessionLifecycle } from "./session-lifecycle.js";
import type { SpeechStreamCancellation } from "./stream-cleanup.js";
import {
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
  let outputTurnId: string | undefined;
  let greetingPending = params.initialGreeting !== undefined;
  let currentWaitingTurn: number | undefined;
  // Native runs own admission; the session only serializes acknowledgments and audio generations.
  let activeConsult: SpeechActiveConsult | undefined;
  let responseQuestion: string | undefined;
  const inputOnset = createSpeechInputOnset<{
    consult: typeof activeConsult;
    nativeRun: ReturnType<ReturnType<typeof createNativeSpeechInput>["captureRun"]>;
    nativePlayback: SpeechPlaybackSnapshot | undefined;
    speechStart: NonNullable<RealtimeVoiceTranscriptEntry["speechStart"]>;
    interruptedEntries: RealtimeVoiceTranscriptEntry[];
    startedAtMs: number;
  }>();
  const agentLogScope = params.logPrefix ? `${params.logPrefix} agent` : "agent";
  const resolved = resolveSpeechTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const sttInputFormat =
    resolved.provider.resolveInputAudioFormat?.(resolved.providerConfig) ?? "g711-ulaw-8khz";
  const sttAudioConverter = createSpeechSttAudioConverter(
    params.config.inputAudioFormat ?? params.config.audioFormat,
    sttInputFormat,
  );
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
  const waiting = createSpeechWaitingController({
    playback: createSpeechWaitingAudioPlayback({
      audio: waitingAudio,
      transport: params.transport,
      isStopped: () => stopped,
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
    closeTranscription: () => sttSession?.close(),
    stopWaiting: () => waiting.stop(),
    drainOutput: () => speechOutput.stopAndDrain(greetingPlayback),
    stopTransport: () => input.stop(),
    disposeTransport: () => params.transport.dispose(),
    publishClosed: () => {
      harness.emit({
        type: "session.closed",
        final: true,
        payload: { sessionId: params.sessionId },
      });
    },
  });
  const stop = () => lifecycle.stop();
  const stopAfterFailure = (source: string) => lifecycle.stopAfterFailure(source);

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
          tailMs: SPEECH_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
          transcriptLookbackMs: SPEECH_TRANSCRIPT_ECHO_LOOKBACK_MS,
          suppressInputDuringOutput: params.transport.supportsFullDuplexInput !== true,
        },
    talkback: params.nativeInput
      ? undefined
      : {
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
                            speechOutput.enqueueSpeechChunk(
                              event.text,
                              utterance,
                              event.speech,
                              event.localServiceAdmission,
                              event.expectedSpeechSelection,
                            );
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
            // Native completion waits for onset resolution. The delivery hold also
            // covers input starting after native retirement, without reviving that run.
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
        dispatch: params.nativeInput,
        session: params,
        inputs,
        video,
        output: speechOutput,
        isStopped: () => stopped,
        getGeneration: () => outputGeneration,
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
              payload: { sessionId: params.sessionId, error: "Native conversation input failed" },
            });
          }
        },
      })
    : undefined;

  const handle: SpeechSessionHandle = {
    providerId: resolved.provider.id,
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
        greetingPending = false;
      },
    }),
    ...(nativeInput
      ? {
          // Programmatic task injection uses the native conversation tools. This media handle
          // does not mint a new user input on behalf of an unauthenticated caller.
          steer: async () => {
            throw new Error("Use the admitted native conversation input to steer this session");
          },
        }
      : {}),
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
      inputAudioFormat: sttInputFormat,
      onSpeechStart: () => {
        if (stopped) {
          return;
        }
        waiting.onSpeechStart();
        greetingPending = false;
        currentWaitingTurn = undefined;
      },
      onSpeechActivity: (event) => {
        if (stopped) {
          return;
        }
        if (event.state === "candidate") {
          params.onActivity?.("sensing");
          try {
            const startedAtMs = Date.now();
            video.begin(event.utteranceId, startedAtMs);
            inputOnset.begin(event.utteranceId, {
              consult: activeConsult,
              nativeRun: nativeInput?.captureRun(),
              nativePlayback: nativeInput?.capturePlayback(
                startedAtMs,
                harness.isOutputPlaybackActive(),
              ),
              interruptedEntries: speechCancellation.captureInterruptedTranscript(),
              speechStart: {
                at: new Date(startedAtMs).toISOString(),
                precedingRequest:
                  activeConsult?.question ??
                  (activeTtsAborts.size + activeTtsReaders.size > 0 ||
                  harness.isOutputPlaybackWindowActive()
                    ? responseQuestion
                    : undefined),
              },
              startedAtMs,
            });
          } catch {
            stopAfterFailure("speech onset lifecycle");
            return;
          }
        } else if (event.state === "rejected") {
          video.settle(event.utteranceId);
          params.onActivity?.("listening");
          inputOnset.settle(event.utteranceId);
        }
        bargeInGate.onSpeechActivity(event);
      },
      onProcessing: (event) => {
        if (event.state === "started") {
          params.onActivity?.("processing");
        } else if (event.state === "speech-confirmed") {
          params.onActivity?.("hearing");
        } else if (event.state === "transcribed") {
          params.onActivity?.("processing");
        } else if (["empty", "failed", "cancelled"].includes(event.state)) {
          params.onActivity?.("listening");
        }
        waiting.onProcessing(event);
        // A VAD confirmation can precede an empty decoder result. Keep the
        // output reversibly paused until a nonempty caller transcript arrives.
        bargeInGate.onProcessing(event);
        if (["transcribed", "empty", "failed", "cancelled"].includes(event.state)) {
          inputOnset.settle(event.utteranceId);
        }
        if (["empty", "failed", "cancelled"].includes(event.state)) {
          video.settle(event.utteranceId);
        }
      },
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
      },
      onError: (error) => {
        params.logger.warn(
          `${params.surface.logScope} ${agentLogScope} transcription bridge failed: ${formatErrorMessage(error)}`,
        );
        harness.emit({
          type: "session.error",
          final: true,
          payload: { sessionId: params.sessionId, error: formatErrorMessage(error) },
        });
        stopAfterFailure("transcription bridge");
      },
    });

    harness.emit({
      type: "session.started",
      payload: { sessionId: params.sessionId, provider: resolved.provider.id },
    });
    // Drain transport input while connect() is pending so the capture pipe never backpressures;
    // chunks before session.ready are dropped instead of arriving later as a stale burst.
    await input.start(
      (audio) => {
        if (stopped || !realtimeReady || audio.byteLength === 0) {
          return;
        }
        if (!harness.recordInputAudio(audio)) {
          return;
        }
        sttSession?.sendAudio(sttAudioConverter.process(audio));
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
  harness.emit({
    type: "session.ready",
    payload: { sessionId: params.sessionId },
  });

  if (params.initialGreeting) {
    const greeting = params.initialGreeting;
    const generation = outputGeneration;
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
      writeOutputAudio: speechOutput.writeOutputAudio,
    }).catch((error: unknown) => lifecycle.fail("greeting playback", error));
  }

  return handle;
}
