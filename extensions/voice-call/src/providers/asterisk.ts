import crypto from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import {
  createRealtimeVoiceAudioQueue,
  createStreamingPcmResampler,
  mulawToPcm,
  pcmToMulaw,
  resamplePcm,
  type RealtimeVoiceAudioQueue,
} from "openclaw/plugin-sdk/realtime-voice";
import type { AsteriskConfig } from "../config.js";
import type { TelephonyTtsProvider } from "../telephony-tts.js";
import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  SendDtmfInput,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import {
  AsteriskAudioSocketServer,
  type AsteriskAudioSocketSession,
} from "./asterisk/audiosocket-server.js";
import { uuidToAudioSocketPayload } from "./asterisk/audiosocket.js";
import type { VoiceCallProvider } from "./base.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type AsteriskRegistration = {
  uuid: string;
  from: string;
  to: string;
  direction: "inbound";
};

type PendingRegistration = AsteriskRegistration & { expiresAt: number };

type ActiveSession = {
  registration: AsteriskAudioSocketSession;
  listening: boolean;
  admitted: boolean;
  terminal: boolean;
  pendingAudio: RealtimeVoiceAudioQueue;
  playbackGeneration: number;
  resampler: ReturnType<typeof createStreamingPcmResampler>;
  transcription?: RealtimeTranscriptionSession;
};

export type AsteriskProviderOptions = {
  config: AsteriskConfig;
  registrationToken: string;
  coreConfig: OpenClawConfig;
  transcriptionProvider: RealtimeTranscriptionProviderPlugin;
  transcriptionProviderConfig: RealtimeTranscriptionProviderConfig;
  logger?: Logger;
};

const E164_PATTERN = /^\+[1-9]\d{1,14}$/u;

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  const comparisonLength = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  const paddedLeft = Buffer.alloc(comparisonLength);
  const paddedRight = Buffer.alloc(comparisonLength);
  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  return (
    crypto.timingSafeEqual(paddedLeft, paddedRight) &&
    leftBytes.byteLength === rightBytes.byteLength
  );
}

function createEventId(uuid: string, kind: string): string {
  return `asterisk:${uuid}:${kind}:${crypto.randomUUID()}`;
}

export class AsteriskProvider implements VoiceCallProvider {
  readonly name = "asterisk" as const;
  private readonly options: AsteriskProviderOptions;
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingRegistration>();
  private readonly active = new Map<string, ActiveSession>();
  private readonly audioSocket: AsteriskAudioSocketServer;
  private eventSink?: (event: NormalizedEvent) => void | Promise<void>;
  private readonly eventDeliveries = new Map<string, Promise<void>>();
  private ttsProvider?: TelephonyTtsProvider;

  constructor(options: AsteriskProviderOptions) {
    this.options = options;
    this.logger = options.logger ?? console;
    this.audioSocket = new AsteriskAudioSocketServer({
      ...options.config.audioSocket,
      consumeRegistration: (uuid) => this.consumeRegistration(uuid),
      onConnect: (session) => {
        void this.handleConnect(session).catch((error: unknown) => {
          this.logger.error(`[voice-call] Asterisk call setup failed: ${String(error)}`);
          const state = this.active.get(session.uuid);
          if (state?.registration === session) {
            this.retireSession(state);
          }
          this.audioSocket.hangup(session.uuid);
        });
      },
      onAudio: (session, pcm, sampleRate) => this.handleAudio(session, pcm, sampleRate),
      onDtmf: (session, digit) => this.handleDtmf(session, digit),
      onHangup: (session) => this.handleHangup(session),
      logger: this.logger,
    });
  }

  setEventSink(sink: (event: NormalizedEvent) => void | Promise<void>): void {
    this.eventSink = sink;
  }

  setTTSProvider(provider: TelephonyTtsProvider): void {
    this.ttsProvider = provider;
  }

  async start(): Promise<{ host: string; port: number }> {
    return await this.audioSocket.start();
  }

  async stop(): Promise<void> {
    for (const session of this.active.values()) {
      this.retireSession(session);
    }
    this.active.clear();
    this.pending.clear();
    await this.audioSocket.stop();
    await Promise.all(this.eventDeliveries.values());
  }

  verifyRegistrationToken(bearerToken: string): boolean {
    return secureEqual(bearerToken, this.options.registrationToken);
  }

  registerInboundCall(input: AsteriskRegistration, bearerToken: string): void {
    if (!this.verifyRegistrationToken(bearerToken)) {
      throw new Error("Unauthorized Asterisk registration");
    }
    const uuid = input.uuid.trim().toLowerCase();
    uuidToAudioSocketPayload(uuid);
    if (!E164_PATTERN.test(input.from) || !E164_PATTERN.test(input.to)) {
      throw new Error("Asterisk registration requires E.164 from and to numbers");
    }
    this.pruneRegistrations();
    if (this.pending.has(uuid) || this.active.has(uuid) || this.audioSocket.hasSession(uuid)) {
      throw new Error("Asterisk call UUID is already registered");
    }
    if (this.pending.size >= this.options.config.audioSocket.maxConnections * 2) {
      throw new Error("Asterisk registration capacity reached");
    }
    this.pending.set(uuid, {
      ...input,
      uuid,
      expiresAt: Date.now() + this.options.config.audioSocket.registrationTtlMs,
    });
  }

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: false, reason: "Asterisk uses its authenticated registration endpoint" };
  }

  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    return { events: [], statusCode: 404, providerResponseBody: "Not Found" };
  }

  async initiateCall(_input: InitiateCallInput): Promise<InitiateCallResult> {
    throw new Error("Asterisk outbound calls require the planned restricted ARI route");
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    this.audioSocket.hangup(input.providerCallId);
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const session = this.active.get(input.providerCallId);
    if (!session || !this.audioSocket.hasSession(input.providerCallId)) {
      throw new Error("Asterisk AudioSocket call is not connected");
    }
    if (!this.ttsProvider) {
      throw new Error("Asterisk telephony TTS is not configured");
    }
    const generation = ++session.playbackGeneration;
    const mulaw = await this.ttsProvider.synthesizeForTelephony(input.text);
    const pcm = resamplePcm(mulawToPcm(mulaw), 8_000, this.options.config.audioSocket.sampleRate);
    const frameBytes = Math.round(this.options.config.audioSocket.sampleRate * 0.02) * 2;
    for (let offset = 0; offset < pcm.byteLength; offset += frameBytes) {
      if (
        session.playbackGeneration !== generation ||
        !this.audioSocket.hasSession(input.providerCallId)
      ) {
        throw new Error("Asterisk TTS playback was interrupted");
      }
      const writable = this.audioSocket.sendAudio(
        input.providerCallId,
        pcm.subarray(offset, Math.min(offset + frameBytes, pcm.byteLength)),
        this.options.config.audioSocket.sampleRate,
      );
      if (!writable && !(await this.audioSocket.waitForDrain(input.providerCallId))) {
        this.audioSocket.hangup(input.providerCallId);
        throw new Error("Asterisk AudioSocket playback backpressure did not recover");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }

  async sendDtmf(input: SendDtmfInput): Promise<void> {
    for (const digit of input.digits) {
      if (!this.audioSocket.sendDtmf(input.providerCallId, digit)) {
        throw new Error("Asterisk DTMF could not be delivered");
      }
    }
  }

  async startListening(input: StartListeningInput): Promise<void> {
    const session = this.active.get(input.providerCallId);
    if (!session) {
      throw new Error("Asterisk AudioSocket call is not connected");
    }
    session.listening = true;
  }

  async stopListening(input: StopListeningInput): Promise<void> {
    const session = this.active.get(input.providerCallId);
    if (session) {
      session.listening = false;
      session.pendingAudio.clear();
    }
  }

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    const connected = this.active.has(input.providerCallId);
    return { status: connected ? "active" : "ended", isTerminal: !connected };
  }

  private pruneRegistrations(): void {
    const now = Date.now();
    for (const [uuid, registration] of this.pending) {
      if (registration.expiresAt <= now) {
        this.pending.delete(uuid);
      }
    }
  }

  private consumeRegistration(uuid: string): AsteriskRegistration | undefined {
    this.pruneRegistrations();
    const registration = this.pending.get(uuid);
    if (!registration) {
      return undefined;
    }
    this.pending.delete(uuid);
    const { expiresAt: _expiresAt, ...call } = registration;
    return call;
  }

  private async handleConnect(registration: AsteriskAudioSocketSession): Promise<void> {
    const state: ActiveSession = {
      registration,
      listening: true,
      admitted: false,
      terminal: false,
      pendingAudio: createRealtimeVoiceAudioQueue("reject-newest"),
      playbackGeneration: 0,
      resampler: createStreamingPcmResampler(this.options.config.audioSocket.sampleRate, 8_000),
    };
    this.active.set(registration.uuid, state);
    const base = {
      callId: registration.uuid,
      providerCallId: registration.uuid,
      timestamp: Date.now(),
      direction: registration.direction,
      from: registration.from,
      to: registration.to,
    } as const;
    const transcription = this.options.transcriptionProvider.createSession({
      cfg: this.options.coreConfig,
      providerConfig: this.options.transcriptionProviderConfig,
      onPartial: () => {
        state.playbackGeneration += 1;
      },
      onSpeechStart: () => {
        state.playbackGeneration += 1;
      },
      onTranscript: (transcript) => {
        const text = transcript.trim();
        if (
          !text ||
          state.terminal ||
          !state.admitted ||
          this.active.get(registration.uuid) !== state
        ) {
          return;
        }
        void this.emitEvent({
          ...base,
          id: createEventId(registration.uuid, "speech"),
          type: "call.speech",
          timestamp: Date.now(),
          transcript: text,
          isFinal: true,
        });
      },
      onError: (error) => {
        this.logger.warn(`[voice-call] Asterisk transcription error: ${error.message}`);
        this.retireSession(state);
        this.audioSocket.hangup(registration.uuid);
      },
    });
    state.transcription = transcription;
    try {
      await transcription.connect();
    } catch (error: unknown) {
      this.logger.error(`[voice-call] Asterisk transcription connect failed: ${String(error)}`);
      this.retireSession(state);
      this.audioSocket.hangup(registration.uuid);
      return;
    }
    if (state.terminal || this.active.get(registration.uuid) !== state) {
      transcription.close();
      return;
    }
    await this.emitEvent({
      ...base,
      id: createEventId(registration.uuid, "initiated"),
      type: "call.initiated",
    });
    if (state.terminal || this.active.get(registration.uuid) !== state) {
      return;
    }
    await this.emitEvent({
      ...base,
      id: createEventId(registration.uuid, "answered"),
      type: "call.answered",
    });
    if (state.terminal || this.active.get(registration.uuid) !== state) {
      return;
    }
    state.admitted = true;
    for (const pcm of state.pendingAudio.drain()) {
      this.handleAudio(registration, pcm, this.options.config.audioSocket.sampleRate);
    }
  }

  private handleAudio(
    registration: AsteriskAudioSocketSession,
    pcm: Buffer,
    sampleRate: number,
  ): void {
    const state = this.active.get(registration.uuid);
    if (!state || state.terminal || !state.listening) {
      return;
    }
    if (sampleRate !== this.options.config.audioSocket.sampleRate) {
      this.logger.warn(
        `[voice-call] Rejecting Asterisk sample-rate change expected=${this.options.config.audioSocket.sampleRate} actual=${sampleRate}`,
      );
      this.retireSession(state);
      this.audioSocket.hangup(registration.uuid);
      return;
    }
    if (!state.admitted) {
      if (!state.pendingAudio.enqueue(pcm)) {
        this.logger.warn("[voice-call] Asterisk admission audio queue exceeded its limit");
        this.retireSession(state);
        this.audioSocket.hangup(registration.uuid);
      }
      return;
    }
    if (!state.transcription?.isConnected()) {
      return;
    }
    const pcm8k = state.resampler.process(pcm);
    if (pcm8k.byteLength > 0) {
      state.transcription.sendAudio(pcmToMulaw(pcm8k));
    }
  }

  private handleDtmf(registration: AsteriskAudioSocketSession, digit: string): void {
    void this.emitEvent({
      id: createEventId(registration.uuid, "dtmf"),
      type: "call.dtmf",
      callId: registration.uuid,
      providerCallId: registration.uuid,
      timestamp: Date.now(),
      digits: digit,
    });
  }

  private handleHangup(registration: AsteriskAudioSocketSession): void {
    const state = this.active.get(registration.uuid);
    if (!state) {
      return;
    }
    this.retireSession(state);
    this.active.delete(registration.uuid);
    void this.emitEvent({
      id: createEventId(registration.uuid, "ended"),
      type: "call.ended",
      callId: registration.uuid,
      providerCallId: registration.uuid,
      timestamp: Date.now(),
      reason: "hangup-user",
    });
  }

  private retireSession(state: ActiveSession): void {
    if (state.terminal) {
      return;
    }
    state.terminal = true;
    state.admitted = false;
    state.pendingAudio.clear();
    state.playbackGeneration += 1;
    state.transcription?.close();
  }

  private emitEvent(event: NormalizedEvent & { providerCallId: string }): Promise<void> {
    const key = event.providerCallId;
    const delivery = (this.eventDeliveries.get(key) ?? Promise.resolve()).then(async () => {
      if (!this.eventSink) {
        throw new Error("Asterisk event sink is not configured");
      }
      await this.eventSink(event);
    });
    // Store settlement, not rejection: an ended event must still be delivered after
    // a failed admission. Different calls must not block one another's admission.
    const settled = delivery.catch((error: unknown) => {
      this.logger.error(`[voice-call] Asterisk event ${event.type} failed: ${String(error)}`);
      const state = this.active.get(key);
      if (state) {
        this.retireSession(state);
      }
      this.audioSocket.hangup(key);
    });
    this.eventDeliveries.set(key, settled);
    void settled.then(() => {
      if (this.eventDeliveries.get(key) === settled) {
        this.eventDeliveries.delete(key);
      }
    });
    return delivery;
  }
}
