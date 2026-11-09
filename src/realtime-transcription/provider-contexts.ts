import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionSessionCallbacks,
} from "./provider-types.js";

export type RealtimeTranscriptionProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: RealtimeTranscriptionProviderConfig;
};

export type RealtimeTranscriptionProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

/** Inputs passed to a provider when creating a transcription session. */
export type RealtimeTranscriptionSessionCreateRequest = RealtimeTranscriptionSessionCallbacks & {
  /** Host-selected wire format; omitted retains legacy mu-law. */
  inputAudioFormat?: "g711-ulaw-8khz" | "pcm16-16khz";
  /** Explicit finishInput owns finalization when the client is the endpointer. */
  inputEndMode?: "server" | "client";
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
};
