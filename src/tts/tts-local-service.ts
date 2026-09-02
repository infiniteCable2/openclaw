import { ensureProviderLocalService } from "../agents/provider-local-service.js";
import type { ProviderLocalServiceConfig } from "../config/types.provider-local-service.js";
import type { SpeechProviderConfig } from "./provider-types.js";

export async function acquireSpeechProviderLocalService(params: {
  providerId: string;
  providerConfig: SpeechProviderConfig;
}): Promise<{ release: () => void } | undefined> {
  const service = readLocalServiceConfig(params.providerId, params.providerConfig.localService);
  if (!service) {
    return undefined;
  }
  const baseUrl = readNonEmptyString(params.providerConfig.baseUrl);
  if (!baseUrl) {
    throw new Error(`tts.providers.${params.providerId}.baseUrl is required with localService`);
  }
  return await ensureProviderLocalService({
    // Matching model and speech provider definitions intentionally share the
    // same manager key when they own the same command and health endpoint.
    providerId: params.providerId,
    baseUrl,
    service,
    configPath: `tts.providers.${params.providerId}.localService`,
  });
}

function readLocalServiceConfig(
  providerId: string,
  value: unknown,
): ProviderLocalServiceConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !readNonEmptyString(value.command)) {
    throw new Error(`tts.providers.${providerId}.localService.command must be a non-empty string`);
  }
  return value as ProviderLocalServiceConfig;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
