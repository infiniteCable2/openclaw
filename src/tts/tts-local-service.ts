import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ensureProviderLocalService } from "../agents/provider-local-service.js";
import type { ProviderLocalServiceConfig } from "../config/types.provider-local-service.js";
import type { SpeechProviderConfig } from "./provider-types.js";

export async function acquireSpeechProviderLocalService(params: {
  providerId: string;
  providerConfig: SpeechProviderConfig;
  signal?: AbortSignal;
}): Promise<{ release: () => void } | undefined> {
  const service = readLocalServiceConfig(params.providerId, params.providerConfig.localService);
  if (!service) {
    return undefined;
  }
  const baseUrl = normalizeOptionalString(params.providerConfig.baseUrl);
  if (!baseUrl) {
    throw new Error(`tts.providers.${params.providerId}.baseUrl is required with localService`);
  }
  return await ensureProviderLocalService(
    {
      // Matching model and speech provider definitions intentionally share the
      // same manager key when they own the same command and health endpoint.
      providerId: params.providerId,
      baseUrl,
      service,
    },
    params.signal,
  );
}

function readLocalServiceConfig(
  providerId: string,
  value: unknown,
): ProviderLocalServiceConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !normalizeOptionalString(value.command)) {
    throw new Error(`tts.providers.${providerId}.localService.command must be a non-empty string`);
  }
  return value as ProviderLocalServiceConfig;
}
