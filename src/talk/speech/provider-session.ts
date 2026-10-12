// Native realtime-provider strategy of the shared speech owner.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../../plugins/runtime/types.js";
import type { RealtimeVoiceProviderPlugin } from "../../plugins/types.js";
import type { RealtimeVoiceAgentConsultResult } from "../agent-consult-runtime.js";
import { isRealtimeVoiceAudioAudible } from "../audio-energy.js";
import type { RealtimeVoiceTool } from "../provider-types.js";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../realtime-session-harness.js";
import { resolveRealtimeVoiceBargeIn } from "../realtime-session-policy.js";
import type { RealtimeVoiceBridgeSession } from "../session-runtime.js";
import type { TalkEvent } from "../talk-events.js";
import { resolveSpeechAudioFormat } from "./audio-format.js";
import { createSpeechRealtimeToolContinuity } from "./provider-continuity.js";
import {
  createSpeechRealtimeOutputOwner,
  createSpeechRealtimeOutputQueue,
} from "./provider-output.js";
import { createSpeechSessionInput } from "./session-input.js";
import {
  buildSpeechSpeakExactUserMessage,
  formatSpeechTranscriptSummaryLog,
  formatSpeechRealtimeVoiceModelLog,
  speechOutputBytesPerMs,
  resolveSpeechRealtimeProvider,
} from "./support.js";
import type { SpeechAudioTransport } from "./transport.js";
import {
  SPEECH_AGENT_TRANSCRIPT_DEBOUNCE_MS,
  SPEECH_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
  SPEECH_TRANSCRIPT_ECHO_LOOKBACK_MS,
  type SpeechRuntimeSurface,
  type SpeechAgentConsultParams,
  type SpeechRealtimeSessionConfig,
  type SpeechRealtimeToolCallParams,
  type SpeechRealtimeSessionHandle,
} from "./types.js";

export async function startSpeechRealtimeSession(params: {
  config: SpeechRealtimeSessionConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  surface: SpeechRuntimeSurface;
  sessionId: string;
  requesterSessionKey?: string;
  logPrefix?: "node";
  talkSessionId?: string;
  talkContext?: { nodeId: string; bridgeId: string };
  transport: SpeechAudioTransport;
  logger: RuntimeLogger;
  providers?: RealtimeVoiceProviderPlugin[];
  consultAgent: (params: SpeechAgentConsultParams) => Promise<RealtimeVoiceAgentConsultResult>;
  tools: RealtimeVoiceTool[];
  handleToolCall: (params: SpeechRealtimeToolCallParams) => Promise<void>;
  onTalkEvent?: (event: TalkEvent) => void;
  onSession?: (session: SpeechRealtimeSessionHandle) => void;
}): Promise<SpeechRealtimeSessionHandle> {
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let bridgeClosed = false;
  let transportStopped = false;
  let transportDisposed = false;
  let closedPublished = false;
  let closeReason = "stopped";
  // Fatal transport callbacks can stop the session before its bridge exists.
  let bridge: RealtimeVoiceBridgeSession | undefined;
  let realtimeReady = false;
  let outputGenerationActive = false;
  let continuityResetActive = false;
  const outputOwner = createSpeechRealtimeOutputOwner();
  const toolContinuity = createSpeechRealtimeToolContinuity(params.handleToolCall);
  const realtimeLogScope = params.logPrefix ? `${params.logPrefix} realtime` : "realtime";
  const audioFormat = resolveSpeechAudioFormat(params.config.audioFormat);
  const input = createSpeechSessionInput(params.transport);
  const assertStarting = () => {
    if (stopped) {
      throw new Error(
        `${params.surface.displayName} audio transport stopped during provider setup`,
      );
    }
  };
  const outputQueue = createSpeechRealtimeOutputQueue({
    transport: params.transport,
    bytesPerMs: speechOutputBytesPerMs(params.config.audioFormat),
    onFailure: (source, error) => {
      params.logger.warn(
        `${params.surface.logScope} ${realtimeLogScope} ${source} failed: ${formatErrorMessage(error)}`,
      );
      stopAfterFailure(source);
    },
  });

  const stop = async () => {
    if (!stopped) {
      stopped = true;
      realtimeReady = false;
      outputOwner.reset();
      outputQueue.stop();
      outputGenerationActive = false;
      toolContinuity.reset("meeting realtime stopped");
      harness.talkback?.close();
      harness.forcedConsults.clear();
    }
    if (stopPromise) {
      await stopPromise;
      return;
    }
    const cleanup = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      if (!bridgeClosed) {
        try {
          await bridge?.close();
          bridgeClosed = true;
          harness.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (!transportStopped) {
        try {
          await input.stop();
          transportStopped = true;
        } catch (error) {
          failures.push(error);
        }
      }
      // Capture closure may unblock an admitted playback write. Disposal must
      // still wait for the exact pump/clear operations owned by this output queue.
      await outputQueue.drain();
      if (transportStopped && !transportDisposed) {
        try {
          await params.transport.dispose();
          transportDisposed = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Speech realtime resources did not close");
      }
      if (!closedPublished) {
        harness.emit({
          type: "session.closed",
          payload: { reason: closeReason },
          final: true,
        });
        closedPublished = true;
      }
    });
    stopPromise = cleanup;
    try {
      await cleanup;
    } finally {
      if (stopPromise === cleanup) {
        stopPromise = undefined;
      }
    }
  };
  const stopAfterFailure = (source: string) => {
    void stop().catch((error: unknown) => {
      params.logger.warn(
        `${params.surface.logScope} ${realtimeLogScope} ${source} cleanup failed: ${formatErrorMessage(error)}`,
      );
    });
  };
  const invalidateOutputPlayback = (): void => {
    outputQueue.invalidate();
    outputGenerationActive = false;
  };
  const invalidateAndClearOutputPlayback = (): void => {
    blockOutput();
    outputQueue.clear();
  };

  const blockOutput = (): { blocked: boolean; token: symbol } => {
    const result = outputOwner.block();
    invalidateOutputPlayback();
    return result;
  };

  const handleOutputBackpressure = () => {
    const { pendingBytes, pendingFrames } = outputQueue.pending();
    const block = bridge?.bridge.outputAudioMode === "continuous" ? undefined : blockOutput();
    if (block && !block.blocked) {
      return;
    }
    params.logger.warn(
      `${params.surface.logScope} ${realtimeLogScope} audio output backpressured: pendingBytes=${pendingBytes} pendingFrames=${pendingFrames}`,
    );
    if (!block) {
      invalidateOutputPlayback();
    }
    harness.flushOutput(outputQueue.clear);
    harness.finishOutputAudio("output-backpressure");
    if (!block) {
      return;
    }
    queueMicrotask(() => {
      if (stopped || !outputOwner.isBlockedBy(block.token)) {
        return;
      }
      harness.handleBargeIn({ audioPlaybackActive: true, force: true }, () => {});
    });
  };

  const startHumanBargeInMonitor = () => {
    if (
      !params.transport.startBargeInMonitor ||
      !resolveRealtimeVoiceBargeIn({
        configuredBargeIn: undefined,
        interruptResponseOnInputAudio: undefined,
        capabilities: resolved.capabilities,
        outputAudioMode: bridge?.bridge.outputAudioMode,
      })
    ) {
      return;
    }
    params.transport.startBargeInMonitor(() => {
      if (stopped || !harness.outputActivity.isInterruptible()) {
        return false;
      }
      const now = Date.now();
      const playbackActive = harness.isOutputPlaybackWindowActive();
      const lastOutputAudioAt = harness.outputActivity.snapshot().lastAudioAt;
      if (!playbackActive && (lastOutputAudioAt === undefined || now - lastOutputAudioAt > 1_000)) {
        return false;
      }
      harness.handleBargeIn({ audioPlaybackActive: true }, invalidateAndClearOutputPlayback);
      return true;
    });
  };

  const resolved = resolveSpeechRealtimeProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const strategy = params.config.strategy;
  params.logger.info(
    formatSpeechRealtimeVoiceModelLog({
      logScope: params.surface.logScope,
      strategy,
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      fallbackModel: params.config.model,
      audioFormat: params.config.audioFormat,
    }),
  );
  const meetingTalkPayload = params.talkContext
    ? { bridgeId: params.talkContext.bridgeId, sessionId: params.sessionId }
    : { sessionId: params.sessionId };
  const outputTalkPayload = params.talkContext
    ? { bridgeId: params.talkContext.bridgeId }
    : { sessionId: params.sessionId };
  const reasonTalkPayload = (reason: string) =>
    params.talkContext ? { bridgeId: params.talkContext.bridgeId, reason } : { reason };
  // The closures above only run after harness creation; they capture this later `const`.
  // Annotated because the consult closure references harness inside its own initializer.
  const harness: RealtimeVoiceSessionHarness = createRealtimeVoiceSessionHarness({
    onTalkEvent: params.onTalkEvent,
    talk: {
      sessionId: params.talkSessionId ?? params.sessionId,
      mode: "realtime",
      transport: "gateway-relay",
      brain:
        strategy === "bidi" && !resolved.capabilities?.handlesAgentConsult
          ? "direct-tools"
          : "agent-consult",
      provider: resolved.provider.id,
    },
    talkPayloads: {
      turnStarted: () => meetingTalkPayload,
      turnEnded: reasonTalkPayload,
      inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioStarted: () => outputTalkPayload,
      outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioDone: reasonTalkPayload,
    },
    echoSuppression: params.transport.inputAudioIsolated
      ? undefined
      : {
          bytesPerMs: speechOutputBytesPerMs(params.config.audioFormat),
          tailMs: SPEECH_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
          transcriptLookbackMs: SPEECH_TRANSCRIPT_ECHO_LOOKBACK_MS,
        },
    talkback: {
      debounceMs: SPEECH_AGENT_TRANSCRIPT_DEBOUNCE_MS,
      logger: params.logger,
      logPrefix: `${params.surface.logScope} ${realtimeLogScope} agent`,
      responseStyle: "Brief, natural spoken answer for a live meeting.",
      fallbackText: "I hit an error while checking that. Please try again.",
      consult: ({ question, responseStyle, signal }) =>
        params.consultAgent({
          sessionId: params.sessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: { question, responseStyle },
          transcript: harness.transcript,
          abortSignal: signal,
        }),
      deliver: (text) => {
        bridge?.sendUserMessage(buildSpeechSpeakExactUserMessage(text));
      },
    },
  });
  const handle: SpeechRealtimeSessionHandle = {
    providerId: resolved.provider.id,
    speak: (instructions) => {
      if (!stopped) {
        bridge?.triggerGreeting(instructions);
      }
    },
    getHealth: () => ({
      ...harness.getHealth({
        providerConnected: bridge?.bridge.isConnected() ?? false,
        realtimeReady,
      }),
      ...(bridge?.bridge.outputAudioMode === "continuous"
        ? { audioOutputActive: outputQueue.hasUnplayedAudibleAudio() }
        : {}),
      ...params.transport.getHealth?.(),
      ...outputQueue.getHealth(),
      bridgeClosed,
    }),
    stop,
  };
  try {
    params.onSession?.(handle);
    harness.emit({
      type: "session.started",
      payload: params.talkContext
        ? { ...meetingTalkPayload, nodeId: params.talkContext.nodeId }
        : meetingTalkPayload,
    });
    params.transport.onFatal(() => {
      stopAfterFailure("audio transport");
    });
    // onFatal may synchronously replay failure before bridge construction.
    if (stopped) {
      throw new Error(
        `${params.surface.displayName} audio transport failed before realtime provider setup`,
      );
    }
    const requireIsolatedInput = () => {
      if (!params.transport.inputAudioIsolated) {
        throw new Error(
          `${params.surface.displayName} native live voice requires isolated audio input. Use an isolated capture transport before connecting.`,
        );
      }
    };
    if (
      resolved.capabilities?.handlesInputAudioBargeIn === true &&
      resolved.capabilities.supportsBargeIn === false
    ) {
      requireIsolatedInput();
    }
    bridge = harness.createBridge({
      provider: resolved.provider,
      capabilities: resolved.capabilities,
      cfg: params.fullConfig,
      agentId: params.config.agentId,
      providerConfig: resolved.providerConfig,
      audioFormat,
      instructions: params.config.instructions,
      initialGreetingInstructions: params.config.introMessage,
      autoRespondToAudio: strategy === "bidi",
      triggerGreetingOnReady: false,
      markStrategy: "ack-immediately",
      tools: strategy === "bidi" && !resolved.capabilities?.handlesAgentConsult ? params.tools : [],
      ...(resolved.capabilities?.handlesAgentConsult
        ? {
            runAgentConsult: (request) => {
              if (stopped) {
                throw new Error("Meeting realtime session is closed");
              }
              return toolContinuity.runConsult(request, async ({ prompt, signal }) => {
                if (params.config.toolPolicy === "none") {
                  throw new Error("Agent delegation is disabled by the meeting tool policy");
                }
                const consulted = await params.consultAgent({
                  sessionId: params.sessionId,
                  requesterSessionKey: params.requesterSessionKey,
                  args: { question: prompt },
                  transcript: harness.transcript,
                  abortSignal: signal,
                });
                // Provider results retain only their public text contract, not host playback state.
                return { text: consulted.text };
              });
            },
          }
        : {}),
      audioSink: {
        isOpen: () => !stopped,
        sendAudio: (audio) => {
          const responseId = outputOwner.takeNextResponseId();
          const continuous = bridge?.bridge.outputAudioMode === "continuous";
          const audible = !continuous || isRealtimeVoiceAudioAudible(audio, audioFormat);
          if (!audible && !outputQueue.hasUnplayedAudibleAudio()) {
            if (outputGenerationActive) {
              outputGenerationActive = false;
              harness.finishOutputAudio("silence");
            }
            return;
          }
          if (stopped || (!continuous && !outputOwner.accept(responseId))) {
            return;
          }
          if (!outputQueue.enqueue(audio, audible, !outputGenerationActive)) {
            handleOutputBackpressure();
            return;
          }
          outputGenerationActive = true;
          harness.outputActivity.markPlaybackStarted();
          harness.recordOutputAudio(audio);
        },
        clearAudio: () => {
          const continuous = bridge?.bridge.outputAudioMode === "continuous";
          if (!continuous && !outputOwner.providerClear()) {
            return;
          }
          if (continuous) {
            outputOwner.reset();
          }
          invalidateOutputPlayback();
          harness.flushOutput(outputQueue.clear);
          harness.finishOutputAudio("clear");
        },
      },
      onTranscript: (role, text, isFinal) => {
        const turnId = harness.ensureTurn();
        const eventType =
          role === "assistant"
            ? isFinal
              ? "output.text.done"
              : "output.text.delta"
            : isFinal
              ? "transcript.done"
              : "transcript.delta";
        const payload = role === "assistant" ? { text } : { role, text };
        harness.emit({
          type: eventType,
          turnId,
          payload,
          final: isFinal,
        });
        if (role === "user" && isFinal) {
          harness.emit({
            type: "input.audio.committed",
            turnId,
            payload: outputTalkPayload,
            final: true,
          });
        }
        if (!isFinal) {
          return;
        }
        params.logger.info(
          formatSpeechTranscriptSummaryLog(
            params.surface.logScope,
            `${realtimeLogScope} ${role}`,
            text,
          ),
        );
        if (role !== "user" || strategy !== "agent") {
          return;
        }
        if (harness.isLikelyAssistantEchoTranscript(text)) {
          params.logger.info(
            formatSpeechTranscriptSummaryLog(
              params.surface.logScope,
              `${realtimeLogScope} ignored assistant echo transcript`,
              text,
            ),
          );
          return;
        }
        if (!stopped) {
          harness.talkback?.enqueue(text);
        }
      },
      onEvent: (event) => {
        if (event.direction === "server" && event.type === "session.created") {
          continuityResetActive = false;
        }
        if (event.direction === "client" && event.type === "session.continuity.reset") {
          if (continuityResetActive) {
            return;
          }
          continuityResetActive = true;
          realtimeReady = false;
          outputOwner.reset();
          outputGenerationActive = false;
          toolContinuity.reset(event.type);
          const turnId = harness.talk.activeTurnId;
          invalidateOutputPlayback();
          harness.flushOutput(outputQueue.clear);
          harness.finishOutputAudio(event.type);
          if (turnId) {
            harness.talk.cancelTurn({
              turnId,
              payload: { ...outputTalkPayload, reason: event.type },
            });
          }
          return;
        }
        outputOwner.noteEvent(event);
        if (event.type === "input_audio_buffer.speech_started") {
          harness.ensureTurn();
        } else if (event.type === "input_audio_buffer.speech_stopped") {
          const turnId = harness.talk.activeTurnId;
          if (!turnId) {
            return;
          }
          harness.emit({
            type: "input.audio.committed",
            turnId,
            payload: { ...outputTalkPayload, source: event.type },
            final: true,
          });
        } else if (
          event.type === "error" &&
          event.detail === "Cancellation failed: no active response found"
        ) {
          if (outputOwner.clearBlocked()) {
            outputGenerationActive = false;
            harness.finishOutputAudio(event.type);
          }
        } else if (event.type === "error") {
          harness.emit({
            type: "session.error",
            payload: { message: event.detail ?? "Realtime provider error" },
            final: true,
          });
        }
        if (
          event.type === "error" ||
          event.type === "response.done" ||
          event.type === "input_audio_buffer.speech_started" ||
          event.type === "input_audio_buffer.speech_stopped" ||
          event.type === "conversation.item.input_audio_transcription.completed" ||
          event.type === "conversation.item.input_audio_transcription.failed"
        ) {
          const detail = event.detail ? ` ${event.detail}` : "";
          params.logger.info(
            `${params.surface.logScope} ${realtimeLogScope} ${event.direction}:${event.type}${detail}`,
          );
        }
      },
      onResponseDone: (outcome) => {
        if (!outputOwner.terminal(outcome.responseId)) {
          return;
        }
        outputGenerationActive = false;
        if (outcome.status === "failed" || outcome.status === "incomplete") {
          params.logger.warn(
            `${params.surface.logScope} ${realtimeLogScope} response ${outcome.status}: ${outcome.message}`,
          );
        }
      },
      onToolCall: (event, session) => {
        if (stopped) {
          return Promise.resolve();
        }
        return toolContinuity.run({
          session,
          call: {
            strategy,
            event,
            sessionId: params.sessionId,
            requesterSessionKey: params.requesterSessionKey,
            transcript: harness.transcript,
          },
          harness,
        });
      },
      onError: (error) => {
        // Provider errors may be recoverable; onClose owns terminal teardown.
        harness.emit({
          type: "session.error",
          payload: { message: formatErrorMessage(error) },
          final: true,
        });
        params.logger.warn(
          `${params.surface.logScope} ${realtimeLogScope} voice bridge failed: ${formatErrorMessage(error)}`,
        );
      },
      onClose: (reason) => {
        outputGenerationActive = false;
        realtimeReady = false;
        harness.finishOutputAudio(reason);
        closeReason = reason;
        stopAfterFailure("voice bridge close");
      },
      onReady: () => {
        if (stopped) {
          return;
        }
        realtimeReady = true;
        continuityResetActive = false;
        harness.emit({
          type: "session.ready",
          payload: outputTalkPayload,
        });
      },
    });
    if (bridge.bridge.outputAudioMode === "continuous") {
      requireIsolatedInput();
    }
    startHumanBargeInMonitor();

    // Drain transport input while connect() is pending so the capture pipe never backpressures.
    // Pre-connect audio is forwarded; the voice bridge owns buffering, matching the previous
    // local command-pair behavior.
    await input.start((audio) => {
      if (stopped || audio.byteLength === 0) {
        return;
      }
      if (!harness.recordInputAudio(audio)) {
        return;
      }
      bridge?.sendAudio(audio);
    }, assertStarting);

    await bridge.connect();
    if (stopped) {
      throw new Error(
        `${params.surface.displayName} audio transport stopped during realtime provider setup`,
      );
    }
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Speech realtime setup and resource cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }

  return handle;
}
