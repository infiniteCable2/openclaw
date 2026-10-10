import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import { resolveSpeechTranscriptionProvider } from "./support.js";
import type { SpeechSessionConfig } from "./types.js";
import { prepareSpeechWaitingAudio } from "./waiting-audio.js";

const SPEECH_READINESS_TIMEOUT_MS = 120_000;

export type SpeechSessionPreparation = {
  release(): Promise<void>;
};

export async function prepareSpeechSession(params: {
  config: SpeechSessionConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  ttsContext?: { agentId?: string; channelId?: string; accountId?: string };
  providers?: RealtimeTranscriptionProviderPlugin[];
  signal?: AbortSignal;
  /** Retain cleanup ownership even when readiness or the first release fails. */
  onPreparation?: (preparation: SpeechSessionPreparation) => void;
}): Promise<SpeechSessionPreparation> {
  const resolved = resolveSpeechTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const timeoutSignal = AbortSignal.timeout(SPEECH_READINESS_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const ttsAgentId = params.ttsContext?.agentId ?? params.config.agentId;
  // A synchronous provider failure must still settle alongside any hold acquired
  // by another provider, so its cleanup owner is not skipped.
  const sttPromise = Promise.resolve().then(() =>
    resolved.provider.prepareSession?.({
      cfg: params.fullConfig,
      providerConfig: resolved.providerConfig,
      signal,
    }),
  );
  const ttsPromise = Promise.resolve().then(() =>
    params.runtime.tts.prepareTextToSpeechTelephony({
      cfg: params.fullConfig,
      signal,
      ...(ttsAgentId ? { agentId: ttsAgentId } : {}),
      ...(params.ttsContext?.channelId ? { channelId: params.ttsContext.channelId } : {}),
      ...(params.ttsContext?.accountId ? { accountId: params.ttsContext.accountId } : {}),
    }),
  );
  const waitingAudioPromise = prepareSpeechWaitingAudio(
    params.config.waitingAudio,
    params.config.audioFormat,
  );
  const [sttResult, ttsResult, waitingAudioResult] = await Promise.allSettled([
    sttPromise,
    ttsPromise,
    waitingAudioPromise,
  ]);
  const releases: Array<() => void | Promise<void>> = [];
  if (sttResult.status === "fulfilled" && sttResult.value) {
    const sttPreparation = sttResult.value;
    releases.push(() => sttPreparation.release());
  }
  if (ttsResult.status === "fulfilled" && ttsResult.value.release) {
    releases.push(ttsResult.value.release);
  }
  const pendingReleases = new Set(releases);
  let releasePromise: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasePromise) {
      return releasePromise;
    }
    releasePromise = (async () => {
      const failures: unknown[] = [];
      await Promise.all(
        [...pendingReleases].map(async (releaseResource) => {
          try {
            await releaseResource();
            pendingReleases.delete(releaseResource);
          } catch (error) {
            // Successful resources stay released; a failed lease remains retryable.
            failures.push(error);
          }
        }),
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Speech preparation resources could not be released");
      }
    })().finally(() => {
      releasePromise = undefined;
    });
    return releasePromise;
  };
  const failPreparation = async (reason: unknown): Promise<never> => {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError(
        [reason, cleanupError],
        "Speech preparation and resource cleanup failed",
        { cause: cleanupError },
      );
    }
    throw reason;
  };
  const preparation = { release };
  try {
    params.onPreparation?.(preparation);
  } catch (error) {
    return failPreparation(error);
  }
  if (sttResult.status === "rejected") {
    return failPreparation(sttResult.reason);
  }
  if (ttsResult.status === "rejected") {
    return failPreparation(ttsResult.reason);
  }
  if (waitingAudioResult.status === "rejected") {
    return failPreparation(waitingAudioResult.reason);
  }
  if (!ttsResult.value.success) {
    return failPreparation(new Error(ttsResult.value.error ?? "TTS telephony preparation failed"));
  }
  return preparation;
}
