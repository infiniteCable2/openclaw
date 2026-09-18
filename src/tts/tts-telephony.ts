import type { Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../config/types.js";
import { finishCapabilityOperation } from "../plugins/capability-provider-acquisition.js";
import type { SpeechTelephonySynthesisResult, TtsDirectiveOverrides } from "./provider-types.js";
import { assertSpeechRuntimeAvailable } from "./runtime-availability.js";
import type {
  TtsTelephonyPreparationResult,
  TtsTelephonyResult,
  TtsTelephonyStreamResult,
} from "./tts-runtime-types.js";
import { captureSpeechProviderStream, ownSpeechStream } from "./tts-streaming-resources.js";
import {
  acquireTtsRequest,
  executeTtsProviderAttempts,
  withOwnedTtsRequest,
} from "./tts-synthesis-support.js";

type TtsTelephonyContext = {
  cfg: OpenClawConfig;
  prefsPath?: string;
  overrides?: TtsDirectiveOverrides;
  timeoutMs?: number;
  agentId?: string;
  channelId?: string;
  accountId?: string;
};

export async function prepareTextToSpeechTelephony(
  params: TtsTelephonyContext & { signal?: AbortSignal },
): Promise<TtsTelephonyPreparationResult> {
  assertSpeechRuntimeAvailable();
  const acquired = await acquireTtsRequest({
    ...params,
    text: "",
    providerOverride: params.overrides?.provider,
  });
  if ("error" in acquired) {
    return { success: false, error: acquired.error };
  }
  let outcome: Result<TtsTelephonyPreparationResult, unknown>;
  try {
    const result = await acquired.run(() =>
      executeTtsProviderAttempts({
        ...acquired.setup,
        synthesisText: "",
        providerOverrides: params.overrides?.providerOverrides,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        target: "telephony",
        logLabel: "TTS telephony preparation",
        requireStreamingTelephony: true,
        prepareSynthesis: false,
        selectOperation: () => ({
          kind: "ready",
          synthesize: async ({ retainLocalService }): Promise<{ release?: () => Promise<void> }> =>
            retainLocalService({}),
          cleanupFailedProjection: async (synthesis) => {
            await synthesis.release?.();
          },
        }),
        buildSuccess: ({ synthesis, ...metadata }) => ({
          success: true as const,
          ...metadata,
          release: synthesis.release,
        }),
      }),
    );
    if (result.success) {
      let completion: Promise<void> | undefined;
      return {
        ...result,
        release: () =>
          (completion ??= (async () => {
            let releaseOutcome: Result<void, unknown>;
            try {
              await acquired.run(async () => {
                await result.release?.();
              });
              releaseOutcome = { ok: true, value: undefined };
            } catch (error) {
              releaseOutcome = { ok: false, error };
            }
            await finishCapabilityOperation(releaseOutcome, acquired.release);
          })()),
      };
    }
    outcome = { ok: true, value: result };
  } catch (error) {
    outcome = { ok: false, error };
  }
  return await finishCapabilityOperation(outcome, acquired.release);
}

function streamBufferedTelephonyResult(result: SpeechTelephonySynthesisResult): {
  audioStream: ReadableStream<Uint8Array>;
  outputFormat: string;
  sampleRate: number;
  release?: () => Promise<void>;
} {
  return {
    audioStream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(result.audioBuffer);
        controller.close();
      },
    }),
    outputFormat: result.outputFormat,
    sampleRate: result.sampleRate,
  };
}

export async function streamTextToSpeechTelephony(
  params: TtsTelephonyContext & { text: string; signal?: AbortSignal },
): Promise<TtsTelephonyStreamResult> {
  assertSpeechRuntimeAvailable();
  const acquired = await acquireTtsRequest({
    ...params,
    providerOverride: params.overrides?.provider,
  });
  if ("error" in acquired) {
    return { success: false, error: acquired.error };
  }
  let outcome: Result<TtsTelephonyStreamResult, unknown>;
  try {
    const result = await acquired.run(() =>
      executeTtsProviderAttempts({
        ...acquired.setup,
        synthesisText: params.text,
        providerOverrides: params.overrides?.providerOverrides,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        target: "telephony",
        logLabel: "TTS telephony stream",
        requireStreamingTelephony: true,
        selectOperation: ({ resolvedProvider }) => ({
          kind: "ready",
          synthesize: async ({ prepared, cfg: runtimeCfg, timeoutMs, retainLocalService }) => {
            const request = {
              text: prepared.text,
              cfg: runtimeCfg,
              providerConfig: prepared.providerConfig,
              providerOverrides: prepared.providerOverrides,
              timeoutMs,
              signal: params.signal,
            };
            const synthesis = resolvedProvider.provider.streamSynthesizeTelephony
              ? await resolvedProvider.provider.streamSynthesizeTelephony(request)
              : streamBufferedTelephonyResult(
                  await resolvedProvider.provider.synthesizeTelephony!(request),
                );
            return {
              providerResult: synthesis,
              transport: await captureSpeechProviderStream(retainLocalService(synthesis), acquired),
            };
          },
          cleanupFailedProjection: async ({ transport }) => {
            await transport.close();
          },
        }),
        buildSuccess: ({ synthesis: { providerResult, transport }, ...metadata }) => ({
          success: true as const,
          ...metadata,
          transport,
          outputFormat: providerResult.outputFormat,
          sampleRate: providerResult.sampleRate,
        }),
      }),
    );
    if (result.success) {
      const { transport, ...metadata } = result;
      return { ...metadata, ...ownSpeechStream(transport, acquired) };
    }
    outcome = { ok: true, value: result };
  } catch (error) {
    outcome = { ok: false, error };
  }
  return await finishCapabilityOperation(outcome, acquired.release);
}

export async function textToSpeechTelephony(
  params: TtsTelephonyContext & { text: string },
): Promise<TtsTelephonyResult> {
  assertSpeechRuntimeAvailable();
  return await withOwnedTtsRequest(
    { ...params, providerOverride: params.overrides?.provider },
    async (setup) => {
      if ("error" in setup) {
        return { success: false, error: setup.error };
      }
      return await executeTtsProviderAttempts({
        ...setup,
        synthesisText: params.text,
        providerOverrides: params.overrides?.providerOverrides,
        timeoutMs: params.timeoutMs,
        target: "telephony",
        logLabel: "TTS telephony",
        requireTelephony: true,
        selectOperation: ({ resolvedProvider }) => ({
          kind: "ready",
          synthesize: ({ prepared, cfg: runtimeCfg, timeoutMs }) =>
            resolvedProvider.provider.synthesizeTelephony!({
              text: prepared.text,
              cfg: runtimeCfg,
              providerConfig: prepared.providerConfig,
              providerOverrides: prepared.providerOverrides,
              timeoutMs,
            }),
        }),
        buildSuccess: ({ synthesis, ...metadata }) => ({
          success: true as const,
          ...metadata,
          audioBuffer: synthesis.audioBuffer,
          outputFormat: synthesis.outputFormat,
          sampleRate: synthesis.sampleRate,
        }),
      });
    },
  );
}
