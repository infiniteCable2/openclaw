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
import { playMeetingAgentGreeting, type PreparedMeetingAgentGreeting } from "./agent-greeting.js";
import { createMeetingAgentWaitingAudio } from "./realtime-agent-waiting-audio.js";
import { createMeetingSttAudioConverter } from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import {
  formatMeetingAgentAudioModelLog,
  formatMeetingTranscriptSummaryLog,
  meetingOutputBytesPerMs,
  resolveMeetingRealtimeTranscriptionProvider,
} from "./realtime-engine-support.js";
import {
  MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS,
  MEETING_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
  MEETING_TRANSCRIPT_ECHO_LOOKBACK_MS,
  type MeetingAgentConsultParams,
  type MeetingRealtimeAudioEngineHandle,
  type MeetingRealtimeEngineConfig,
  type MeetingRuntimePlatform,
} from "./realtime-engine.js";
import { createMeetingInputOnset } from "./realtime-input-onset.js";
import { createMeetingBargeInGate } from "./realtime-output-gate.js";
import { createMeetingSpeechCancellation } from "./realtime-speech-cancellation.js";
import {
  createMeetingSpeechOutput,
  type MeetingSpeechUtterance,
} from "./realtime-speech-output.js";
import { createMeetingWaitingAudioPlayback, prepareMeetingWaitingAudio } from "./waiting-audio.js";

export {
  prepareMeetingAgentRealtimeEngine,
  type MeetingAgentRealtimePreparation,
} from "./realtime-agent-preparation.js";

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
  initialGreeting?: PreparedMeetingAgentGreeting;
  /** Optional device presentation hint; never changes turn or media ownership. */
  onActivity?: (activity: "listening" | "sensing" | "hearing" | "processing" | "speaking") => void;
}): Promise<MeetingRealtimeAudioEngineHandle> {
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let sttSession: RealtimeTranscriptionSession | null = null;
  let realtimeReady = false;
  const activeTtsAborts = new Set<AbortController>();
  const activeTtsReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let outputGeneration = 0;
  let greetingPending = params.initialGreeting !== undefined;
  let currentWaitingTurn: number | undefined;
  // Admission belongs to the native run. This only serializes its acknowledgments
  // before choosing an audio generation or handing an unadopted input to talkback.
  let activeConsult:
    | {
        control?: Parameters<NonNullable<MeetingAgentConsultParams["onRunControl"]>>[0];
        admissions: Promise<void>;
        adoptedGeneration: number;
        unconfirmed: boolean;
        followupOnly: boolean;
        question: string;
      }
    | undefined;
  let responseQuestion: string | undefined;
  const inputOnset = createMeetingInputOnset<{
    consult: typeof activeConsult;
    speechStart: NonNullable<RealtimeVoiceTranscriptEntry["speechStart"]>;
    interruptedEntries: RealtimeVoiceTranscriptEntry[];
  }>();
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
    // Full-duplex sinks can resume music after estimated TTS playout; the longer
    // echo-suppression tail stays independent, and a paused gate adds a drain hold.
    canStart: () =>
      activeTtsReaders.size === 0 &&
      bargeInGate.canResumeWaitingAudio() &&
      !(params.transport.supportsFullDuplexInput === true
        ? harness.isOutputPlaybackActive()
        : harness.isOutputPlaybackWindowActive()),
    resumeDelayMs: waitingAudio?.resumeDelayMs ?? 800,
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
    inputOnset.close();
    speechCancellation.markInterruptedTranscript();
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
      await speechOutput.drain();
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
    // Do not start a new answer while an acoustic candidate is unresolved.
    // Already playing speech still uses the existing reversible duck/pause gate.
    if (firstChunk) {
      await inputOnset.wait();
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
    if (!isCurrent()) {
      return false;
    }
    await params.transport.writeOutput(audio);
    // A successful handoff remains a fact even when cancellation raced the
    // asynchronous write. Callers record it before checking the generation.
    return true;
  };

  const speechCancellation = createMeetingSpeechCancellation({
    harness: () => harness,
    activeTtsAborts,
    activeTtsReaders,
    bargeInGate,
  });

  const speechOutput = createMeetingSpeechOutput({
    config: params.config,
    fullConfig: params.fullConfig,
    runtime: params.runtime,
    platform: params.platform,
    meetingSessionId: params.meetingSessionId,
    ttsContext: params.ttsContext,
    ttsAgentId,
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
    writeOutputAudio,
  });
  const {
    createSpeechUtterance,
    isCurrentSpeechUtterance,
    enqueueSpeechChunk,
    finalizeSpeechUtterance,
  } = speechOutput;

  const abortSpeechUtterance = (utterance: MeetingSpeechUtterance) => {
    if (!isCurrentSpeechUtterance(utterance)) {
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

  const enqueueSpeakText = (text: string | undefined) => {
    const utterance = createSpeechUtterance(currentWaitingTurn);
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
        params.onActivity?.("processing");
        const waitingTurn = waiting.onTurnStarted();
        currentWaitingTurn = waitingTurn;
        const utterance = createSpeechUtterance(waitingTurn);
        const consult: NonNullable<typeof activeConsult> = {
          admissions: Promise.resolve(),
          adoptedGeneration: outputGeneration,
          unconfirmed: false,
          followupOnly: false,
          question,
        };
        activeConsult = consult;
        responseQuestion = question;
        let failure: { error: unknown } | undefined;
        const result = await params
          .consultAgent({
            meetingSessionId: params.meetingSessionId,
            requesterSessionKey: params.requesterSessionKey,
            args: { question, responseStyle },
            transcript: harness.transcript,
            abortSignal: signal,
            onRunControl: (control) => {
              consult.control = control;
            },
            waitForPendingInput: (runSignal) =>
              inputOnset.waitForChange((onset) => onset.consult === consult, runSignal),
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
          isCurrentSpeechUtterance(utterance)
        ) {
          await waiting.stop(utterance.waitingGeneration);
          waiting.onTurnFinished(waitingTurn);
          if (currentWaitingTurn === waitingTurn) {
            currentWaitingTurn = undefined;
          }
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
            });
          } catch {
            stopAfterFailure("speech onset lifecycle");
            return;
          }
        } else if (event.state === "rejected") {
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
      },
      onTranscript: (text, context) => {
        const reservation = inputOnset.claim(context?.utteranceId);
        const onset = reservation?.value;
        const trimmed = text.trim();
        if (!trimmed || stopped) {
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
          payload: { meetingSessionId: params.meetingSessionId },
        });
        harness.emit({
          type: "transcript.done",
          turnId,
          final: true,
          payload: { meetingSessionId: params.meetingSessionId, text: trimmed, role: "user" },
        });
        const userEntry = harness.recordTranscript("user", trimmed);
        if (onset && !assistantEcho) {
          userEntry.speechStart = onset.speechStart;
        }
        params.logger.info(
          formatMeetingTranscriptSummaryLog(
            params.platform.logScope,
            `${agentLogScope} user`,
            trimmed,
          ),
        );
        if (assistantEcho) {
          reservation?.release();
          params.logger.info(
            formatMeetingTranscriptSummaryLog(
              params.platform.logScope,
              `${agentLogScope} ignored assistant echo transcript`,
              trimmed,
            ),
          );
          return;
        }
        // A late transcript must not steer a different run that happened to
        // start during STT. Only the exact onset owner may accept the addition.
        const consult = onset ? onset.consult : activeConsult;
        if (!consult || consult !== activeConsult) {
          harness.talkback?.enqueue(trimmed);
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
              harness.talkback?.enqueue(trimmed);
              return;
            }
            // Release on queue acceptance, not transcript commit: commitment
            // needs the held native loop to resume. Decoder terminal callbacks
            // cannot release this claimed reservation before admission.
            const outcome = reservation
              ? await control?.(trimmed, reservation.release)
              : await control?.(trimmed);
            if (stopped) {
              return;
            }
            if (outcome?.queued) {
              // queued=true also covers uncertain commit: never resubmit it.
              consult.adoptedGeneration = generation;
              consult.unconfirmed ||= !outcome.ok;
              consult.followupOnly ||= !outcome.ok;
            } else {
              // Once B waits behind A, C must not overtake B by steering into A.
              consult.followupOnly = true;
              harness.talkback?.enqueue(trimmed);
            }
          })
          .catch(() => {
            // An exception cannot prove non-adoption. Do not replay a possible
            // write-capable input; report the uncertainty after the run settles.
            consult.unconfirmed = true;
            consult.followupOnly = true;
            params.logger.warn(
              `${params.platform.logScope} ${agentLogScope} input steering confirmation failed`,
            );
          })
          .finally(() => reservation?.release());
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

  if (params.initialGreeting) {
    const greeting = params.initialGreeting;
    const generation = outputGeneration;
    void playMeetingAgentGreeting({
      greeting,
      transport: params.transport,
      harness,
      meetingSessionId: params.meetingSessionId,
      activeTtsAborts,
      isCurrent: () => !stopped && outputGeneration === generation,
      canStart: () => greetingPending,
      onStarted: () => {
        greetingPending = false;
      },
      writeOutputAudio,
    }).catch((error: unknown) => {
      if (!stopped) {
        params.logger.warn(
          `${params.platform.logScope} ${agentLogScope} greeting playback failed: ${formatErrorMessage(error)}`,
        );
        stopAfterFailure("greeting playback");
      }
    });
  }

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
