import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveFailoverReasonFromError } from "../../../agents/failover-error.js";
import { projectInternalRealtimeVoicePublicConfig } from "../../../talk/provider-internal.js";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "../../../talk/provider-types.js";
import type {
  CreateTalkRealtimeRelaySessionParams,
  TalkRealtimeRelaySessionResult,
} from "./state.js";

export function buildTalkRealtimeRelaySessionResult(params: {
  relaySessionId: string;
  provider: string;
  model?: string;
  voice?: string;
  expiresAtMs: number;
}): TalkRealtimeRelaySessionResult {
  return {
    provider: params.provider,
    transport: "gateway-relay",
    relaySessionId: params.relaySessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
      outputEncoding: "pcm16",
      outputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
    },
    ...(params.model ? { model: params.model } : {}),
    ...(params.voice ? { voice: params.voice } : {}),
    expiresAt: Math.floor(params.expiresAtMs / 1000),
  };
}

export function resolveTalkRealtimeRelayPresentation(
  params: Pick<
    CreateTalkRealtimeRelaySessionParams,
    | "provider"
    | "providerConfig"
    | "model"
    | "voice"
    | "clientCapabilities"
    | "voiceSelectionVoices"
  >,
) {
  const providerModel = normalizeOptionalString(params.providerConfig.model);
  const model =
    normalizeOptionalString(params.model) ?? providerModel ?? params.provider.defaultModel;
  const voice =
    normalizeOptionalString(params.voice) ?? normalizeOptionalString(params.providerConfig.voice);
  const voices = [...(params.voiceSelectionVoices ?? [])];
  const publicModel = projectInternalRealtimeVoicePublicConfig({
    provider: params.provider,
    providerConfig: params.providerConfig,
    config: { model },
  }).model;
  const opaqueRoute = Boolean(model && publicModel !== model);
  return {
    publicModel,
    voice,
    selection: {
      provider: params.provider.id,
      model: publicModel,
      voice,
      voices,
      canChange:
        params.clientCapabilities?.includes("voice-selection") === true && voices.length > 0,
    },
    launch: { provider: params.provider.id, model: providerModel ?? model },
    publicError: (error: unknown) =>
      new Error(projectTalkRealtimeRelayProviderError(params.provider.id, opaqueRoute, error)),
  };
}

function projectTalkRealtimeRelayProviderError(
  provider: string,
  opaqueRoute: boolean,
  error: unknown,
): string {
  if (opaqueRoute) {
    return "Realtime provider error.";
  }
  switch (resolveFailoverReasonFromError(error, provider)) {
    case "auth":
    case "auth_permanent":
      return "Realtime provider authentication failed. Check the provider credentials and try again.";
    case "format":
    case "model_not_found":
      return "Realtime session configuration was rejected. Check the provider and model settings.";
    case "rate_limit":
    case "billing":
      return "Realtime provider cannot start this session right now. Try again later.";
    case "timeout":
    case "overloaded":
    case "server_error":
      return "Realtime provider is unavailable. Try again later.";
    default:
      return "Realtime provider error.";
  }
}
