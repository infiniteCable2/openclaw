import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { assertSpeechExpressionOverridePolicy } from "./directives.js";
import { buildSpeechExpressionGuidance } from "./expression-guidance.js";
import { isSpeechExpressionEnabled } from "./expression.js";
import type { SpeechSynthesisTarget, TtsDirectiveOverrides } from "./provider-types.js";
import type { TtsTelephonyPreparationResult } from "./tts-runtime-types.js";
import { resolveTtsConfig } from "./tts-settings.js";

export type PreparedSpeechExpressionContext = {
  guidance: string;
  expectedSpeechSelection?: { provider: string; model?: string; voice?: string };
  localServiceAdmission?: TtsTelephonyPreparationResult["localServiceAdmission"];
  segmentationProfile?: TtsTelephonyPreparationResult["segmentationProfile"];
  assertCurrent(): void;
  release(): Promise<void>;
};

/** Prepare only an admitted speech output, retaining the existing readiness owner for its run. */
export async function prepareSpeechExpressionContext(params: {
  cfg: OpenClawConfig;
  tts: Pick<PluginRuntime["tts"], "prepareTextToSpeech">;
  agentId?: string;
  channelId?: string;
  accountId?: string;
  target: SpeechSynthesisTarget;
  currentSourceSpeechTarget: boolean;
  commentaryEnabled: boolean;
  prefsPath?: string;
  overrides?: TtsDirectiveOverrides;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PreparedSpeechExpressionContext | undefined> {
  if (!isSpeechExpressionEnabled(params)) {
    return undefined;
  }
  assertSpeechExpressionOverridePolicy(
    resolveTtsConfig(params.cfg, {
      agentId: params.agentId,
      channelId: params.channelId,
      accountId: params.accountId,
    }).modelOverrides,
  );
  const prepare = params.tts.prepareTextToSpeech;
  if (!prepare) {
    throw new Error("Enabled speech expressions require native speech readiness support");
  }
  params.signal?.throwIfAborted();
  const prepared = await prepare({
    cfg: params.cfg,
    target: params.target,
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
    prefsPath: params.prefsPath,
    overrides: params.overrides,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  let closed = false;
  let releaseCompletion: Promise<void> | undefined;
  const release = () => {
    closed = true;
    return (releaseCompletion ??= Promise.resolve().then(() => prepared.release?.()));
  };
  const assertCurrent = () => {
    if (closed) {
      throw new Error("Speech expression preparation is closed");
    }
    params.signal?.throwIfAborted();
    prepared.localServiceAdmission?.signal.throwIfAborted();
  };
  try {
    assertCurrent();
    if (!prepared.success || !prepared.expressionCapabilities) {
      throw new Error("Selected speech provider did not admit expression capabilities");
    }
    const guidance = buildSpeechExpressionGuidance({
      capabilities: prepared.expressionCapabilities,
      target: params.target,
      currentSourceSpeechTarget: params.currentSourceSpeechTarget,
      commentaryEnabled: params.commentaryEnabled,
    });
    return {
      guidance,
      ...(prepared.provider
        ? {
            expectedSpeechSelection: {
              provider: prepared.provider,
              model: prepared.providerModel,
              voice: prepared.providerVoice,
            },
          }
        : {}),
      localServiceAdmission: prepared.localServiceAdmission,
      segmentationProfile: prepared.segmentationProfile,
      assertCurrent,
      release,
    };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Speech expression admission and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}
