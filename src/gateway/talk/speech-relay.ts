import { randomUUID } from "node:crypto";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import { resolveActiveTalkProviderConfig } from "../../config/talk.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createMeetingRealtimeEngineBindingsV2 } from "../../meeting-bot/conversation-bindings.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import type { RealtimeTranscriptionProviderConfig } from "../../realtime-transcription/provider-types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveRealtimeVoiceAgentControlIntent } from "../../talk/agent-run-control-shared.js";
import { createClientVoiceConfirmationReadiness } from "../../talk/client-voice-confirmation-readiness.js";
import { releaseConversationInputAdmission } from "../../talk/conversation-input-admission.js";
import { forgetUnifiedTalkSession, getUnifiedTalkSession } from "../../talk/session-registry.js";
import { prepareSpeechGreeting } from "../../talk/speech/greeting.js";
import { controlAdmittedSpeechSession } from "../../talk/speech/native-control.js";
import { prepareSpeechSession } from "../../talk/speech/preparation.js";
import { resolveTalkSpeechAgentProfile } from "../../talk/speech/profile.js";
import { startSpeechSession } from "../../talk/speech/session.js";
import type { SpeechAudioTransport } from "../../talk/speech/transport.js";
import type { SpeechSessionHandle } from "../../talk/speech/types.js";
import type { TalkEvent } from "../../talk/talk-session-controller.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../talk/voice-transcript.js";
import type { GatewayRequestContext } from "../server-methods/shared-types.js";
import type { TalkOperatorRunSource } from "./client-agent-runtime.js";
import type { TalkAgentConsultAuthority } from "./client-gateway-control.js";
import { createGatewayTalkConversationInputSource } from "./conversation-input-source.js";
import { decodeTalkRelayAudioBase64 } from "./relay-audio-base64.js";
import {
  closeRelayVoiceSession,
  ensureRelayVoiceSession,
  type RelayVoiceSessionOwner,
} from "./relay/voice.js";
import { rememberTalkSpeechRelaySession } from "./session-registry.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";
import { buildTalkTtsConfig } from "./speech-config.js";
import { createNativeSpeechConfirmation } from "./speech-confirmation.js";

const SESSION_TTL_MS = 30 * 60 * 1000;
const PLAYBACK_READY_TIMEOUT_MS = 30_000;
const MAX_AUDIO_BASE64_BYTES = 512 * 1024;

export type TalkSpeechRelaySession = {
  kind: "speech-relay";
  id: string;
  connId: string;
  sessionTarget: PreparedTalkSessionTarget;
  appendAudio(audioBase64: string, endOfInput?: boolean): Promise<void>;
  acknowledgeMark(markName: string): void;
  cancelOutput: SpeechSessionHandle["cancelOutput"];
  steer: SpeechSessionHandle["steer"];
  close(): Promise<void>;
};

/** Transport-only adapter. Native Talk owns admission; the shared speech owner
 * owns all recognition, agent steering, synthesis, music and output generations. */
export async function createTalkSpeechRelaySession(params: {
  context: GatewayRequestContext;
  connId: string;
  cfg: OpenClawConfig;
  sessionTarget: PreparedTalkSessionTarget;
  authority: TalkAgentConsultAuthority;
  captureOperatorAuthority?: TalkOperatorRunSource;
  callerId?: string;
  participant?: SessionParticipantIdentity;
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
  capabilities?: readonly ("voice-selection" | "isolated-input" | "output-gate")[];
  assertCurrent: () => void;
}) {
  params.assertCurrent();
  if (
    params.capabilities?.includes("isolated-input") &&
    !params.capabilities.includes("output-gate")
  ) {
    throw new Error("Full-duplex Talk speech requires isolated-input and output-gate capabilities");
  }
  const talkSpeech = resolveActiveTalkProviderConfig(params.cfg.talk)
    ? buildTalkTtsConfig(params.cfg)
    : undefined;
  if (talkSpeech && "error" in talkSpeech) {
    throw new Error(talkSpeech.error);
  }
  const speechConfig = talkSpeech?.cfg ?? params.cfg;
  const profile = resolveTalkSpeechAgentProfile(params.cfg, params.sessionTarget.agentId);
  const id = randomUUID();
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  const readyMark = `media-ready:${randomUUID()}`;
  const lifetime = new AbortController();
  const ready = createDeferredCore();
  // Shutdown may precede the first output that awaits readiness.
  void ready.promise.catch(() => {});
  let readyAcknowledged = false;
  let input: ((audio: Buffer) => void) | undefined;
  let fatal: (() => void) | undefined;
  let engine: SpeechSessionHandle | undefined;
  let preparation: Awaited<ReturnType<typeof prepareSpeechSession>> | undefined;
  let greetingPreparation: Awaited<ReturnType<typeof prepareSpeechSession>> | undefined;
  let closing: Promise<void> | undefined;
  let construction: Promise<void> = Promise.resolve();
  const connectionPreparation: {
    current?: ReturnType<typeof createMeetingRealtimeEngineBindingsV2>["connectionPreparation"];
  } = {};
  let activeTurnId: string | undefined;
  let closeReason: "completed" | "error" = "completed";

  const assertActive = () => {
    lifetime.signal.throwIfAborted();
    params.assertCurrent();
    if (getUnifiedTalkSession(id) !== record) {
      throw new Error("Talk speech session is no longer current");
    }
  };
  const broadcast = (payload: Record<string, unknown>) => {
    // No frame or text may be delivered after its connection/target was revoked.
    assertActive();
    params.context.broadcastToConnIds(
      "talk.event",
      { sessionId: id, relaySessionId: id, ...payload },
      new Set([params.connId]),
    );
  };
  const voice: RelayVoiceSessionOwner = {
    id,
    sessionTarget: params.sessionTarget,
    provider: params.provider.id,
    voiceConfig: params.cfg,
    context: params.context,
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
    confirmationReadiness: createClientVoiceConfirmationReadiness({
      agentId: params.sessionTarget.agentId,
      voiceSessionId: id,
      flushTranscript: async () => {
        await voice.voiceTranscriptQueue.flush({ requireSuccess: true });
      },
    }),
    failSession: () => {
      closeReason = "error";
      fatal?.();
      void record
        .close()
        .catch((error: unknown) =>
          params.context.logGateway.warn(`Talk speech cleanup failed: ${String(error)}`),
        );
    },
  };
  const publishEventRequired = (talkEvent: TalkEvent) => {
    if (lifetime.signal.aborted) {
      return;
    }
    if (talkEvent.type === "turn.started") {
      activeTurnId = talkEvent.turnId;
    } else if (talkEvent.type === "turn.ended" || talkEvent.type === "turn.cancelled") {
      activeTurnId = undefined;
    }
    const payload = talkEvent.payload;
    if (
      (talkEvent.type === "transcript.done" || talkEvent.type === "output.text.done") &&
      payload &&
      typeof payload === "object" &&
      "text" in payload &&
      typeof payload.text === "string"
    ) {
      const role = talkEvent.type === "transcript.done" ? "user" : "assistant";
      // Native getReply is the one ordinary user/assistant transcript writer.
      // Harness captions are presentation, not proof of a committed user input.
      broadcast({ type: "transcript", role, text: payload.text, final: true, talkEvent });
    } else {
      broadcast({ type: talkEvent.type === "session.ready" ? "ready" : "event", talkEvent });
    }
  };
  const publishEvent = (talkEvent: TalkEvent) => {
    try {
      publishEventRequired(talkEvent);
    } catch {
      // Harness observers are best-effort, but durable input and requested
      // delivery are not. Revoke this adapter before any further consultation.
      voice.confirmationReadiness.fail(new Error("Talk speech delivery failed"));
      closeReason = "error";
      lifetime.abort(new Error("Talk speech delivery failed"));
      params.context.logGateway.warn("Talk speech delivery failed; closing the session");
      void record
        .close()
        .catch(() => params.context.logGateway.warn("Talk speech cleanup remains pending"));
    }
  };
  const transport: SpeechAudioTransport = {
    // A generic client has not proven an active echo canceller or isolated capture.
    // Do not claim full duplex simply because its websocket is bidirectional.
    supportsFullDuplexInput: params.capabilities?.includes("isolated-input") === true,
    inputAudioIsolated: params.capabilities?.includes("isolated-input") === true,
    onFatal(callback) {
      fatal = callback;
    },
    async startInput(callback) {
      assertActive();
      input = callback;
    },
    async waitForRemoteAudioReady() {
      assertActive();
      await racePromiseWithAbortSignal(
        ready.promise,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(PLAYBACK_READY_TIMEOUT_MS)]),
      );
      assertActive();
    },
    beginOutput() {
      assertActive();
    },
    async writeOutput(audio) {
      // Every output purpose, including waiting music, obeys the same readiness gate.
      await transport.waitForRemoteAudioReady?.();
      assertActive();
      // Keep the released relay's 20 ms PCM output envelope bounded.
      for (let offset = 0; offset < audio.byteLength; offset += 960) {
        broadcast({
          type: "audio",
          audioBase64: audio.subarray(offset, offset + 960).toString("base64"),
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
        });
      }
    },
    async clearOutput() {
      if (!lifetime.signal.aborted) {
        broadcast({ type: "clear" });
      }
    },
    ...(params.capabilities?.includes("output-gate")
      ? {
          async setOutputGate(gate: "normal" | "duck" | "paused") {
            broadcast({ type: "outputGate", gate });
          },
        }
      : {}),
    async stop() {
      input = undefined;
    },
    async dispose() {
      input = undefined;
    },
  };
  const record: TalkSpeechRelaySession = {
    kind: "speech-relay",
    id,
    connId: params.connId,
    sessionTarget: params.sessionTarget,
    async appendAudio(audioBase64, endOfInput) {
      assertActive();
      if (!readyAcknowledged || !input) {
        throw new Error(
          "Talk speech playback must acknowledge the readyMark before capture starts",
        );
      }
      const inputOwner = engine;
      if (endOfInput && !inputOwner?.supportsInputEnd) {
        throw new Error("Talk speech transcription provider does not support endOfInput");
      }
      if (audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
        throw new Error("Talk speech audio frame is too large");
      }
      const audio =
        audioBase64 === "" && endOfInput
          ? Buffer.alloc(0)
          : decodeTalkRelayAudioBase64(audioBase64, "Talk speech");
      if (audio.byteLength % 2 !== 0) {
        throw new Error("Talk speech input requires complete PCM16 samples");
      }
      if (audio.byteLength > 0) {
        input(audio);
      }
      if (endOfInput) {
        if (!inputOwner) {
          throw new Error("Talk speech session is not ready");
        }
        await inputOwner.finishInput();
        assertActive();
      }
    },
    acknowledgeMark(markName) {
      assertActive();
      if (markName !== readyMark) {
        throw new Error("Unknown Talk speech playback readiness mark");
      }
      readyAcknowledged = true;
      ready.resolve();
    },
    cancelOutput(options) {
      assertActive();
      if (!engine) {
        throw new Error("Talk speech session is not ready");
      }
      return engine.cancelOutput(options);
    },
    async steer(options) {
      assertActive();
      options.assertCurrent?.();
      if (!engine) {
        throw new Error("Talk speech session is not ready");
      }
      const scope = {
        agentId: params.sessionTarget.agentId,
        conversationId: id,
        inputId: randomUUID(),
        purpose: "steering" as const,
      };
      const admission = await inputSource.admitInput({ ...scope, signal: options.signal });
      try {
        assertActive();
        options.assertCurrent?.();
        return await controlAdmittedSpeechSession(engine, {
          admission,
          scope,
          text: options.text,
          mode: resolveRealtimeVoiceAgentControlIntent(options).mode,
          signal: options.signal,
          assertInputCurrent: options.assertCurrent,
        });
      } finally {
        releaseConversationInputAdmission(admission);
      }
    },
    close() {
      if (closing) {
        return closing;
      }
      lifetime.abort(new Error("Talk speech session closed"));
      connectionPreparation.current?.cancel();
      ready.reject(lifetime.signal.reason);
      if (expiryTimer) {
        clearTimeout(expiryTimer);
      }
      voice.closing = true;
      voice.confirmationReadiness.close();
      // Stop capture and provider connection setup before joining construction.
      // A disconnected client must not retain a pending connect or readiness lease.
      fatal?.();
      closing = (async () => {
        await construction.catch(() => {});
        // Preparation leases remain held while synthesis and accepted transcript
        // writes drain. Releasing them concurrently could unload a live provider.
        const stopped = await Promise.allSettled([
          engine?.stop(),
          connectionPreparation.current?.close(),
        ]);
        const engineReleased = stopped.every((result) => result.status === "fulfilled");
        const results = [
          ...stopped,
          ...(await Promise.allSettled([
            engineReleased
              ? (async () => {
                  await greetingPreparation?.release();
                  greetingPreparation = undefined;
                  await preparation?.release();
                })()
              : undefined,
            closeRelayVoiceSession(voice),
          ])),
        ];
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          closing = undefined;
          throw new AggregateError(failures, "Talk speech resources did not close");
        }
        forgetUnifiedTalkSession(id);
        params.context.broadcastToConnIds(
          "talk.event",
          { sessionId: id, relaySessionId: id, type: "close", reason: closeReason },
          new Set([params.connId]),
        );
      })();
      return closing;
    },
  };
  rememberTalkSpeechRelaySession(record);
  const expiryTimer = setTimeout(() => {
    void record
      .close()
      .catch((error: unknown) =>
        params.context.logGateway.warn(`Talk speech expiry cleanup failed: ${String(error)}`),
      );
  }, SESSION_TTL_MS);
  expiryTimer.unref?.();
  const inputSource = createGatewayTalkConversationInputSource({
    target: params.sessionTarget,
    conversationId: id,
    getRuntimeConfig: params.context.getRuntimeConfig,
    captureOperatorAuthority: params.captureOperatorAuthority ?? (async () => undefined),
    authority: params.authority,
    participant: params.participant,
    connectionAbortSignal: lifetime.signal,
    assertInputCurrent: assertActive,
    resolveGatewayContext: () => params.context,
  });
  const bindings = createMeetingRealtimeEngineBindingsV2({
    platform: {
      id: "talk",
      displayName: "Talk",
      logScope: "talk",
      agentConsult: {
        surface: "a server-processed Talk speech session",
        userLabel: "User",
        assistantLabel: "Assistant",
        questionSourceLabel: "user",
        workingResponseLabel: "the request",
        extraSystemPrompt: "Respond naturally for a live spoken conversation.",
      },
      session: { idPrefix: "talk", participantIdentity: () => "gateway-caller" },
    },
    inputSource,
    agentId: params.sessionTarget.agentId,
    conversationId: id,
    assertOutputCurrent: assertActive,
    ttsContext: { agentId: params.sessionTarget.agentId, channelId: "talk" },
    config: {
      realtime: {
        agentId: params.sessionTarget.agentId,
        toolPolicy: params.authority.toolsAllow ? "safe-read-only" : "owner",
        speakCommentary: profile.speakCommentary,
      },
    },
    fullConfig: speechConfig,
    runtime: createPluginRuntime(),
    logger: params.context.logGateway,
    connectionPresentation: {
      kind: "browser",
      channel: "talk",
      label: "Browser speech conversation",
      readTarget: {
        agentId: params.sessionTarget.agentId,
        sessionKey: params.sessionTarget.canonicalKey,
      },
      input: { audio: true },
      output: { audio: true },
      operations: ["current-turn-reply", "cancel-output"],
      assertCurrent: assertActive,
    },
  });
  connectionPreparation.current = bindings.connectionPreparation;
  const config = {
    audioFormat: "pcm16-24khz" as const,
    inputAudioFormat: "pcm16-16khz" as const,
    agentId: params.sessionTarget.agentId,
    transcriptionProvider: params.provider.id,
    providers: { [params.provider.id]: params.providerConfig },
    responseStreaming: profile.responseStreaming,
    ...(profile.waitingAudio ? { waitingAudio: profile.waitingAudio } : {}),
  };
  const nativeInput = createNativeSpeechConfirmation({
    agentId: params.sessionTarget.agentId,
    sessionKey: params.sessionTarget.sessionKey,
    canonicalSessionKey: params.sessionTarget.canonicalKey,
    voiceSessionId: id,
    config: params.cfg,
    dispatch: bindings.nativeInput,
    onOutputFailure: (error) =>
      params.context.logGateway.warn(`Talk speech confirmation output failed: ${String(error)}`),
  });
  construction = (async () => {
    const runtime = createPluginRuntime();
    assertActive();
    preparation = await prepareSpeechSession({
      config,
      fullConfig: speechConfig,
      runtime,
      providers: [params.provider],
      signal: lifetime.signal,
      onPreparation(prepared) {
        preparation = prepared;
      },
      ttsContext: { agentId: params.sessionTarget.agentId, channelId: "talk" },
    });
    assertActive();
    let initialGreeting;
    if (profile.greeting) {
      if (!ensureRelayVoiceSession(voice)) {
        throw new Error("Talk speech greeting requires a recorded voice session");
      }
      const greeting = profile.greeting;
      // Preparing an opening sentence is not permission to execute user tools.
      try {
        initialGreeting = await prepareSpeechGreeting({
          cfg: speechConfig,
          runtime,
          consultAgent: ({ sessionId, ...consult }) =>
            bindings.consultAgent({ ...consult, meetingSessionId: sessionId }),
          sessionId: id,
          requesterSessionKey: params.sessionTarget.canonicalKey,
          callerId:
            params.callerId ?? "not supplied by this transport; do not infer it from the agent ID",
          prompt: greeting.prompt,
          timeZone: greeting.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          audioFormat: config.audioFormat,
          ttsContext: { agentId: params.sessionTarget.agentId, channelId: "talk" },
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(greeting.timeoutMs)]),
          onPreparation(prepared) {
            greetingPreparation = prepared;
          },
        });
        greetingPreparation = undefined;
        assertActive();
      } catch (error) {
        // A policy permitting greeting failure never overrides lost authority.
        assertActive();
        if (greeting.onFailure !== "continue") {
          throw error;
        }
        // Optional speech never makes failed/unknown provider cleanup optional.
        await greetingPreparation?.release();
        greetingPreparation = undefined;
        assertActive();
        params.context.logGateway.warn(
          "Talk greeting preparation failed; continuing without greeting",
        );
      }
    }
    engine = await startSpeechSession({
      config,
      fullConfig: speechConfig,
      runtime,
      signal: lifetime.signal,
      initialGreeting,
      onSession(owner) {
        engine = owner;
      },
      surface: { displayName: "Talk", logScope: "talk", sessionIdPrefix: "talk" },
      sessionId: id,
      requesterSessionKey: params.sessionTarget.canonicalKey,
      ttsContext: { agentId: params.sessionTarget.agentId, channelId: "talk" },
      transport,
      logger: params.context.logGateway,
      providers: [params.provider],
      consultAgent: async (consult) => {
        assertActive();
        return bindings.consultAgent({ ...consult, meetingSessionId: consult.sessionId });
      },
      nativeInput: async (consult) => {
        assertActive();
        if (!ensureRelayVoiceSession(voice)) {
          throw new Error("Talk speech input requires its recorded voice session");
        }
        return nativeInput(consult);
      },
      connectionPresentation: bindings.connectionPresentation,
      connectionPreparation: bindings.connectionPreparation,
      onTalkEvent: publishEvent,
    });
    assertActive();
  })();
  try {
    await construction;
  } catch (error) {
    await record.close();
    throw error;
  }
  return {
    sessionId: id,
    relaySessionId: id,
    provider: params.provider.id,
    mode: "stt-tts" as const,
    transport: "gateway-relay" as const,
    brain: "agent-consult" as const,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 16000,
      supportsInputEnd: engine?.supportsInputEnd === true,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
    readyMark,
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}
