import type { OpenClawConfig } from "../config/types.js";
import type { SpeechTelephonySynthesisResult, TtsDirectiveOverrides } from "./provider-types.js";
import { assertSpeechRuntimeAvailable } from "./runtime-availability.js";
import type {
  TtsTelephonyPreparationResult,
  TtsTelephonyResult,
  TtsTelephonyStreamResult,
} from "./tts-runtime-types.js";
import { executeTtsProviderAttempts, resolveTtsRequestSetup } from "./tts-synthesis-support.js";

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
  const setup = resolveTtsRequestSetup({
    text: "",
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { cfg, config, persona, providers } = setup;
  return await executeTtsProviderAttempts({
    cfg,
    config,
    persona,
    providers,
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
      retainLocalServiceUntilRelease: true,
      synthesize: async (): Promise<{ release?: () => Promise<void> }> => ({}),
    }),
    buildSuccess: ({ synthesis, ...metadata }) => ({
      success: true,
      ...metadata,
      release: synthesis.release,
    }),
  });
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
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { cfg, config, persona, providers } = setup;
  return await executeTtsProviderAttempts({
    cfg,
    config,
    persona,
    providers,
    synthesisText: params.text,
    providerOverrides: params.overrides?.providerOverrides,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    target: "telephony",
    logLabel: "TTS telephony stream",
    requireStreamingTelephony: true,
    selectOperation: ({ resolvedProvider }) => ({
      kind: "ready",
      retainLocalServiceUntilRelease: true,
      synthesize: async ({ prepared, cfg: runtimeCfg, timeoutMs }) => {
        const request = {
          text: prepared.text,
          cfg: runtimeCfg,
          providerConfig: prepared.providerConfig,
          providerOverrides: prepared.providerOverrides,
          timeoutMs,
          signal: params.signal,
        };
        if (resolvedProvider.provider.streamSynthesizeTelephony) {
          return await resolvedProvider.provider.streamSynthesizeTelephony(request);
        }
        const buffered = await resolvedProvider.provider.synthesizeTelephony!(request);
        return streamBufferedTelephonyResult(buffered);
      },
    }),
    buildSuccess: ({ synthesis, ...metadata }) => ({
      success: true,
      ...metadata,
      audioStream: synthesis.audioStream,
      outputFormat: synthesis.outputFormat,
      sampleRate: synthesis.sampleRate,
      release: synthesis.release,
    }),
  });
}

export async function textToSpeechTelephony(
  params: TtsTelephonyContext & {
    text: string;
  },
): Promise<TtsTelephonyResult> {
  assertSpeechRuntimeAvailable();
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { cfg, config, persona, providers } = setup;
  return await executeTtsProviderAttempts({
    cfg,
    config,
    persona,
    providers,
    synthesisText: params.text,
    providerOverrides: params.overrides?.providerOverrides,
    timeoutMs: params.timeoutMs,
    target: "telephony",
    logLabel: "TTS telephony",
    requireTelephony: true,
    selectOperation: ({ resolvedProvider }) => {
      const synthesizeTelephony = resolvedProvider.provider.synthesizeTelephony as NonNullable<
        typeof resolvedProvider.provider.synthesizeTelephony
      >;
      return {
        kind: "ready",
        synthesize: ({ prepared, cfg: runtimeCfg, timeoutMs }) =>
          synthesizeTelephony({
            text: prepared.text,
            cfg: runtimeCfg,
            providerConfig: prepared.providerConfig,
            providerOverrides: prepared.providerOverrides,
            timeoutMs,
          }),
      };
    },
    buildSuccess: ({ synthesis, ...metadata }) => ({
      success: true,
      ...metadata,
      audioBuffer: synthesis.audioBuffer,
      outputFormat: synthesis.outputFormat,
      sampleRate: synthesis.sampleRate,
    }),
  });
}
