// Realtime transcription provider types describe streaming transcription providers.
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Public contracts for realtime transcription provider plugins and sessions.
// Providers own config resolution; core owns session lifecycle shape.
export type RealtimeTranscriptionProviderId = string;

export type RealtimeTranscriptionProviderConfig = Record<string, unknown>;

export type RealtimeTranscriptionProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: RealtimeTranscriptionProviderConfig;
};

export type RealtimeTranscriptionProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

/** Inputs used to make a realtime transcription provider ready before media starts. */
export type RealtimeTranscriptionProviderPrepareRequest = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
  signal?: AbortSignal;
};

/** Resources retained while a prepared realtime transcription session is in use. */
export type RealtimeTranscriptionProviderPreparation = {
  release(): void | Promise<void>;
};

/** Callback hooks emitted by realtime transcription sessions. */
export type RealtimeTranscriptionSessionCallbacks = {
  onPartial?: (partial: string) => void;
  onTranscript?: (transcript: string, context?: { utteranceId: string }) => void;
  onSpeechStart?: () => void;
  /**
   * Reversible acoustic activity before endpoint/STT admission. Candidate and
   * sustained are energy evidence, never a confirmed user turn. A rejected
   * candidate has no later onProcessing terminal event.
   */
  onSpeechActivity?: (event: {
    utteranceId: string;
    state: "candidate" | "sustained" | "rejected";
  }) => void;
  /**
   * Optional utterance processing lifecycle. IDs are unique within a session.
   * Emit started at admission, before queued work; speech-confirmed requires
   * positive speech detection, not an energy threshold or request submission.
   * Emit one terminal state after onTranscript (if any), also on cancellation.
   */
  onProcessing?: (event: {
    utteranceId: string;
    state: "started" | "speech-confirmed" | "transcribed" | "empty" | "failed" | "cancelled";
  }) => void;
  onError?: (error: Error) => void;
};

/** Inputs passed to a provider when creating a transcription session. */
export type RealtimeTranscriptionSessionCreateRequest = RealtimeTranscriptionSessionCallbacks & {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
  /** Host-selected wire format; absent means the legacy 8 kHz mu-law stream. */
  inputAudioFormat?: "g711-ulaw-8khz" | "pcm16-16khz";
};

/** Runtime control surface for a realtime transcription session. */
export type RealtimeTranscriptionSession = {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  close(): void;
  isConnected(): boolean;
};
