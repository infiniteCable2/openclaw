import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import { resolveMeetingRealtimeTranscriptionProvider } from "./realtime-engine-support.js";
import type { MeetingRealtimeEngineConfig } from "./realtime-engine.js";
import { prepareMeetingWaitingAudio } from "./waiting-audio.js";

const MEETING_AGENT_READINESS_TIMEOUT_MS = 120_000;

export type MeetingAgentRealtimePreparation = {
  release(): Promise<void>;
};

export async function prepareMeetingAgentRealtimeEngine(params: {
  config: MeetingRealtimeEngineConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  ttsContext?: { agentId?: string; channelId?: string; accountId?: string };
  providers?: RealtimeTranscriptionProviderPlugin[];
  signal?: AbortSignal;
}): Promise<MeetingAgentRealtimePreparation> {
  const resolved = resolveMeetingRealtimeTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const timeoutSignal = AbortSignal.timeout(MEETING_AGENT_READINESS_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const ttsAgentId = params.ttsContext?.agentId ?? params.config.realtime.agentId;
  const sttPromise = resolved.provider.prepareSession?.({
    cfg: params.fullConfig,
    providerConfig: resolved.providerConfig,
    signal,
  });
  const ttsPromise = params.runtime.tts.prepareTextToSpeechTelephony({
    cfg: params.fullConfig,
    signal,
    ...(ttsAgentId ? { agentId: ttsAgentId } : {}),
    ...(params.ttsContext?.channelId ? { channelId: params.ttsContext.channelId } : {}),
    ...(params.ttsContext?.accountId ? { accountId: params.ttsContext.accountId } : {}),
  });
  const waitingAudioPromise = prepareMeetingWaitingAudio(
    params.config.realtime.waitingAudio,
    params.config.chrome.audioFormat,
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
  const release = async () => {
    await Promise.allSettled(releases.splice(0).map(async (releaseResource) => releaseResource()));
  };
  if (sttResult.status === "rejected") {
    await release();
    throw sttResult.reason;
  }
  if (ttsResult.status === "rejected") {
    await release();
    throw ttsResult.reason;
  }
  if (waitingAudioResult.status === "rejected") {
    await release();
    throw waitingAudioResult.reason;
  }
  if (!ttsResult.value.success) {
    await release();
    throw new Error(ttsResult.value.error ?? "TTS telephony preparation failed");
  }
  return { release };
}
