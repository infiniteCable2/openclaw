import { normalizeOptionalString as readLogString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
} from "../../plugins/types.js";
import {
  getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders,
} from "../../realtime-transcription/provider-registry.js";
import type { RealtimeTranscriptionProviderConfig } from "../../realtime-transcription/provider-types.js";
import { truncateUtf16Safe } from "../../utils.js";
import {
  resolveConfiguredRealtimeVoiceProvider,
  type ResolvedRealtimeVoiceProvider,
} from "../provider-resolver.js";
import type { RealtimeVoiceProviderConfig } from "../provider-types.js";
import type { SpeechAudioFormat } from "./audio-format.js";

type SpeechProviderSelectionConfig = {
  agentId?: string;
  provider?: string;
  transcriptionProvider?: string;
  voiceProvider?: string;
  model?: string;
  providers: Record<string, Record<string, unknown>>;
};

type ResolvedRealtimeTranscriptionProvider = {
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

export function speechOutputBytesPerMs(audioFormat: SpeechAudioFormat): number {
  return audioFormat === "g711-ulaw-8khz" ? 8 : 48;
}

export function resolveSpeechRealtimeProvider(params: {
  config: SpeechProviderSelectionConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeVoiceProviderPlugin[];
}): ResolvedRealtimeVoiceProvider {
  const providerId = params.config.voiceProvider ?? params.config.provider;
  return resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId: providerId,
    providerConfigs: params.config.providers,
    cfg: params.fullConfig,
    agentId: params.config.agentId,
    surface: "gateway-relay",
    useProviderDefaultModel: true,
    providers: params.providers,
    defaultModel: params.config.model,
    noRegisteredProviderMessage: "No configured realtime voice provider registered",
  });
}

export function resolveSpeechTranscriptionProvider(params: {
  config: SpeechProviderSelectionConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeTranscriptionProviderPlugin[];
}): ResolvedRealtimeTranscriptionProvider {
  const providerId = params.config.transcriptionProvider ?? params.config.provider;
  const configuredProvider = providerId
    ? params.providers
      ? params.providers.find(
          (entry) => entry.id === providerId || entry.aliases?.includes(providerId),
        )
      : getRealtimeTranscriptionProvider(providerId, params.fullConfig)
    : undefined;
  if (providerId && !configuredProvider) {
    throw new Error(`Realtime transcription provider "${providerId}" is not registered`);
  }
  // Targeted native lookup retains lazy plugin loading; an explicitly supplied
  // provider set remains an authoritative operation scope and cannot be escaped.
  const provider =
    configuredProvider ??
    (params.providers ?? listRealtimeTranscriptionProviders(params.fullConfig))[0];
  if (!provider) {
    throw new Error("No configured realtime transcription provider registered");
  }
  const rawConfig = providerId
    ? (params.config.providers[providerId] ?? params.config.providers[provider.id] ?? {})
    : (params.config.providers[provider.id] ?? {});
  const providerConfig = provider.resolveConfig
    ? provider.resolveConfig({ cfg: params.fullConfig, rawConfig })
    : rawConfig;
  if (!provider.isConfigured({ cfg: params.fullConfig, providerConfig })) {
    throw new Error(`Realtime transcription provider "${provider.id}" is not configured`);
  }
  return { provider, providerConfig };
}

export function buildSpeechSpeakExactUserMessage(text: string): string {
  return [
    "Speak this exact OpenClaw answer to the meeting, without adding, removing, or rephrasing words.",
    `Answer: ${JSON.stringify(text)}`,
  ].join("\n");
}

function formatLogValue(value: string | undefined): string {
  const normalized = value ? truncateUtf16Safe(value.replace(/\s+/g, "_"), 180) : undefined;
  return normalized || "unknown";
}

function resolveProviderModelForLog(params: {
  provider: { defaultModel?: string };
  providerConfig: RealtimeVoiceProviderConfig | RealtimeTranscriptionProviderConfig;
  fallbackModel?: string;
}): string {
  return (
    readLogString(params.providerConfig.model) ??
    readLogString(params.providerConfig.modelId) ??
    readLogString(params.fallbackModel) ??
    readLogString(params.provider.defaultModel) ??
    "provider-default"
  );
}

export function formatSpeechRealtimeVoiceModelLog(params: {
  logScope: string;
  strategy: string;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  fallbackModel?: string;
  audioFormat: SpeechAudioFormat;
}): string {
  return [
    `${params.logScope} realtime voice bridge starting: strategy=${formatLogValue(params.strategy)}`,
    `provider=${formatLogValue(params.provider.id)}`,
    `model=${formatLogValue(resolveProviderModelForLog(params))}`,
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

export function formatSpeechAgentAudioModelLog(params: {
  logScope: string;
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
  audioFormat: SpeechAudioFormat;
}): string {
  return [
    `${params.logScope} agent audio bridge starting: transcriptionProvider=${formatLogValue(
      params.provider.id,
    )}`,
    `transcriptionModel=${formatLogValue(resolveProviderModelForLog(params))}`,
    "tts=telephony",
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

type SpeechTtsResultLogFields = {
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
  outputFormat?: string;
  sampleRate?: number;
  fallbackFrom?: string;
};

export function formatSpeechTtsResultLog(
  logScope: string,
  prefix: string,
  result: SpeechTtsResultLogFields,
): string {
  return [
    `${logScope} ${prefix} TTS: provider=${formatLogValue(result.provider)}`,
    `model=${formatLogValue(result.providerModel)}`,
    `voice=${formatLogValue(result.providerVoice)}`,
    `outputFormat=${formatLogValue(result.outputFormat)}`,
    `sampleRate=${result.sampleRate ?? "unknown"}`,
    ...(result.fallbackFrom ? [`fallbackFrom=${formatLogValue(result.fallbackFrom)}`] : []),
  ].join(" ");
}

export function formatSpeechTranscriptSummaryLog(
  logScope: string,
  prefix: string,
  text: string,
): string {
  return `${logScope} ${prefix}: chars=${text.length}`;
}

export function normalizeSpeechPromptText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sayExactly = trimmed.match(/^say exactly:\s*(?<text>.+)$/is)?.groups?.text?.trim();
  if (sayExactly) {
    return sayExactly.replace(/^["']|["']$/g, "").trim() || trimmed;
  }
  return trimmed;
}
