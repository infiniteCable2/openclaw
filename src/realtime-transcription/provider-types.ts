import type { OpenClawConfig } from "../config/types.openclaw.js";
// Public contracts for realtime transcription provider plugins and sessions.
// Providers own config resolution; core owns session lifecycle shape.
export type RealtimeTranscriptionProviderId = string;

export type RealtimeTranscriptionProviderConfig = Record<string, unknown>;

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
  /** Synchronous live-authority check; failure requires aborting without finalization. */
  assertCurrent?: () => void;
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

export type {
  RealtimeTranscriptionSessionCreateRequest,
  RealtimeTranscriptionProviderResolveConfigContext,
  RealtimeTranscriptionProviderConfiguredContext,
} from "./provider-contexts.js";
/** Runtime control surface for a realtime transcription session. */
export type RealtimeTranscriptionSession = {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  /**
   * Finalize retained real audio at an explicit capture boundary, not disconnect.
   * close() must cancel/unblock outstanding finish work so teardown can join it.
   */
  finishInput?(options?: {
    captureId: string;
  }): void | { activity: "none" | "observed" } | Promise<void | { activity: "none" | "observed" }>;
  close(): void;
  isConnected(): boolean;
};
