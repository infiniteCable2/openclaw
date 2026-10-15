// Shared transport-neutral STT, native agent admission, and speech delivery owner.
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { RealtimeTranscriptionSession } from "../../realtime-transcription/provider-types.js";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../realtime-session-harness.js";
import type { RealtimeVoiceTranscriptEntry } from "../session-log-runtime.js";
import { createSpeechSttAudioConverter } from "./audio-format.js";
import { createSpeechCancellation } from "./cancellation.js";
import { playSpeechGreeting } from "./greeting.js";
import { createSpeechInputOnset } from "./input-onset.js";
import { createSpeechBargeInGate } from "./output-gate.js";
import { createSpeechOutput, type SpeechUtterance } from "./output.js";
import { createSpeechSessionControls } from "./session-controls.js";
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
  let sttSession: RealtimeTranscriptionSession | null = null;
  let realtimeReady = false;
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

  const lifecycle = createSpeechSessionLifecycle({
    logger: params.logger,
    logScope: `${params.surface.logScope} ${agentLogScope}`,
    fence() {
      stopped = true;
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
    drainOutput: async () => {
      await Promise.allSettled([...activeTtsReaders].map((reader) => reader.cancel()));
      const drained = await Promise.allSettled([speechOutput.drain(), greetingPlayback]);
      const failures = drained.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Speech output did not drain",
        );
      }
    },
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
    onFailure: (error) => {
      params.logger.warn(
        `${params.surface.logScope} ${agentLogScope} output gate failed: ${formatErrorMessage(error)}`,
      );
      stopAfterFailure("output gate");
    },
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
    finishWaitingTurn: (turn) => {
      waiting.onTurnFinished(turn);
      if (currentWaitingTurn === turn) {
        currentWaitingTurn = undefined;
      }
    },
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
      waiting.onTurnFinished(utterance.waitingTurn);
      if (currentWaitingTurn === utterance.waitingTurn) {
        currentWaitingTurn = undefined;
      }
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
    talkback: {
      debounceMs:
        resolved.provider.transcriptGranularity === "utterance"
          ? 0
          : SPEECH_AGENT_TRANSCRIPT_DEBOUNCE_MS,
      logger: params.logger,
      logPrefix: `${params.surface.logScope} ${agentLogScope}`,
      responseStyle: "Brief, natural spoken answer for a live conversation.",
      fallbackText: "I hit an error while checking that. Please try again.",
      onDiscardMetadata: (metadata) => video.resolve(metadata)?.release(),
      metadataMergeKey: video.mergeKey,
      mergeMetadata: video.merge,
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
        const snapshot = video.resolve(metadata);
        if (snapshot) {
          consult.releaseVideo.add(snapshot.release);
        }
        const result: Awaited<ReturnType<typeof params.consultAgent>> = await Promise.resolve()
          .then(async () => {
            const visualInput = await video.prepare(snapshot, signal);
            return params.consultAgent({
              sessionId: params.sessionId,
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
            waiting.onTurnFinished(waitingTurn);
            if (currentWaitingTurn === waitingTurn) {
              currentWaitingTurn = undefined;
            }
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
          waiting.onTurnFinished(waitingTurn);
          if (currentWaitingTurn === waitingTurn) {
            currentWaitingTurn = undefined;
          }
          return { ...result, text: "" };
        }
        if (
          !result.text.trim() &&
          utterance.chunks.length === 0 &&
          speechOutput.isCurrentSpeechUtterance(utterance)
        ) {
          await waiting.stop(utterance.waitingGeneration);
          waiting.onTurnFinished(waitingTurn);
          if (currentWaitingTurn === waitingTurn) {
            currentWaitingTurn = undefined;
          }
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
            video.begin(event.utteranceId, Date.now());
            inputOnset.begin(event.utteranceId, {
              consult: activeConsult,
              interruptedEntries: speechCancellation.captureInterruptedTranscript(),
              speechStart: {
                at: new Date().toISOString(),
                precedingRequest:
                  activeConsult?.question ??
                  (activeTtsAborts.size + activeTtsReaders.size > 0 ||
                  harness.isOutputPlaybackWindowActive()
                    ? responseQuestion
                    : undefined),
              },
              startedAtMs: Date.now(),
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
        const snapshot = video.capture(
          onset?.startedAtMs ?? Date.now() - 2000,
          Date.now(),
          context?.utteranceId,
        );
        const enqueueInput = () => {
          if (!harness.talkback?.enqueue(trimmed, snapshot)) {
            snapshot?.release();
          }
        };
        // A late transcript must not steer a different run that happened to
        // start during STT. Only the exact onset owner may accept the addition.
        const consult = onset ? onset.consult : activeConsult;
        if (!consult || consult !== activeConsult) {
          enqueueInput();
          reservation?.release();
          return;
        }
        const control = consult.control;
        const generation = outputGeneration;
        consult.admissions = consult.admissions
          .then(async () => {
            if (stopped) {
              return;
            }
            if (consult.followupOnly) {
              enqueueInput();
              return;
            }
            // Release on queue acceptance, not transcript commit: commitment
            // needs the held native loop to resume. Decoder terminal callbacks
            // cannot release this claimed reservation before admission.
            const frameInput = await video.prepare(snapshot);
            if (stopped) {
              return;
            }
            const inputText = frameInput.context ? `${trimmed}\n\n${frameInput.context}` : trimmed;
            const outcome = await control?.(inputText, reservation?.release, {
              images: frameInput.images,
            });
            if (stopped) {
              return;
            }
            if (outcome?.queued) {
              // queued=true also covers uncertain commit: never resubmit it.
              consult.adoptedGeneration = generation;
              consult.unconfirmed ||= !outcome.ok;
              consult.followupOnly ||= !outcome.ok;
              if (snapshot) {
                consult.releaseVideo.add(snapshot.release);
              }
            } else {
              // Once B waits behind A, C must not overtake B by steering into A.
              consult.followupOnly = true;
              enqueueInput();
            }
          })
          .catch(() => {
            // An exception cannot prove non-adoption. Do not replay a possible
            // write-capable input; report the uncertainty after the run settles.
            consult.unconfirmed = true;
            consult.followupOnly = true;
            // An uncertain native adoption can still be processing this input.
            if (snapshot) {
              consult.releaseVideo.add(snapshot.release);
            }
            params.logger.warn(
              `${params.surface.logScope} ${agentLogScope} input steering confirmation failed`,
            );
          })
          .finally(() => reservation?.release());
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
    }).catch((error: unknown) => {
      if (!stopped) {
        params.logger.warn(
          `${params.surface.logScope} ${agentLogScope} greeting playback failed: ${formatErrorMessage(error)}`,
        );
        stopAfterFailure("greeting playback");
      }
    });
  }

  return handle;
}
