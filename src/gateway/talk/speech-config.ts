import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveActiveTalkProviderConfig } from "../../config/talk.js";
import type { TalkProviderConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig, TtsConfig, TtsProviderConfigMap } from "../../config/types.js";
import { assertSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import { canonicalizeSpeechProviderId, getSpeechProvider } from "../../tts/provider-registry.js";
import {
  withSpeakerSelectionCompat,
  withSpeakerSelectionFallbackCompat,
} from "../../tts/speaker.js";
import { providerMatchesId } from "../../tts/voice-models.js";

export type TalkSpeakReason =
  | "talk_unconfigured"
  | "talk_provider_unsupported"
  | "synthesis_failed"
  | "invalid_audio_result";

export function withTalkBaseTtsSpeakerSelectionCompat(
  baseTts: Record<string, unknown>,
  talkProvider?: { provider: { id: string; aliases?: readonly string[] }; apiKey?: unknown },
): Record<string, unknown> {
  const next = withSpeakerSelectionCompat(baseTts);
  const providers = asOptionalRecord(baseTts.providers);
  if (providers) {
    next.providers = Object.fromEntries(
      Object.entries(providers).map(([providerId, providerConfig]) => {
        const normalized = withSpeakerSelectionCompat(asOptionalRecord(providerConfig) ?? {});
        // Talk-owned overrides must shield provider normalization from a cold global TTS ref.
        if (
          typeof talkProvider?.apiKey === "string" &&
          providerMatchesId(talkProvider.provider, providerId) &&
          typeof normalized.apiKey === "object"
        ) {
          normalized.apiKey = talkProvider.apiKey;
        }
        return [providerId, normalized];
      }),
    );
  }
  for (const [key, value] of Object.entries(baseTts)) {
    if (key === "providers") {
      continue;
    }
    const record = asOptionalRecord(value);
    if (record) {
      next[key] = withSpeakerSelectionCompat(record);
    }
  }
  return next;
}

export function buildTalkTtsConfig(
  config: OpenClawConfig,
):
  | { cfg: OpenClawConfig; provider: string; providerConfig: TalkProviderConfig }
  | { error: string; reason: TalkSpeakReason } {
  const resolved = resolveActiveTalkProviderConfig(config.talk);
  const provider = canonicalizeSpeechProviderId(resolved?.provider, config);
  if (!resolved || !provider) {
    return {
      error: "talk.speak unavailable: talk provider not configured",
      reason: "talk_unconfigured",
    };
  }
  assertSecretOwnerAvailable("capability", "talk:speech");

  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider) {
    return {
      error: `talk.speak unavailable: speech provider "${provider}" does not support Talk mode`,
      reason: "talk_provider_unsupported",
    };
  }

  const providerConfig = withSpeakerSelectionFallbackCompat(resolved.config);
  // Normalization copies schema-owned config and adds string speaker aliases or
  // the resolved Talk API key to provider records without changing other fields.
  const baseTts = withTalkBaseTtsSpeakerSelectionCompat(asOptionalRecord(config.tts) ?? {}, {
    provider: speechProvider,
    apiKey: providerConfig.apiKey,
  }) as TtsConfig; // SAFETY: Speaker normalization preserves schema-owned TTS fields.
  const resolvedProviderConfig =
    speechProvider.resolveTalkConfig?.({
      cfg: config,
      // SAFETY: This record view preserves the same schema-owned normalized TTS values.
      baseTtsConfig: baseTts as Record<string, unknown>,
      talkProviderConfig: providerConfig,
      timeoutMs: baseTts.timeoutMs ?? 30_000,
    }) ?? providerConfig;
  const talkTts: TtsConfig = {
    ...baseTts,
    auto: "always",
    provider,
    providers: {
      // SAFETY: Normalization preserves these schema-owned provider API key/service contracts.
      ...((asOptionalRecord(baseTts.providers) ?? {}) as TtsProviderConfigMap),
      [provider]: resolvedProviderConfig,
    },
  };

  return {
    provider,
    providerConfig,
    cfg: {
      ...config,
      tts: talkTts,
    },
  };
}
