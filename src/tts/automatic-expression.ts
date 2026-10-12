import { resolveChannelTtsVoiceDelivery } from "../channels/plugins/tts-capabilities.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { prepareSpeechExpressionContext } from "./expression-preparation.js";
import { isSpeechExpressionEnabled } from "./expression.js";
import type { MessageSpeechAdmission } from "./message-speech-admission.js";
import type { PreparedTtsPreferences } from "./tts-preferences.js";
import { resolveTtsSettingsSnapshot } from "./tts-settings.js";

export type PreparedAutomaticSpeechExpressionContext = {
  guidance: string;
  messageSpeechAdmission: MessageSpeechAdmission;
  release(): Promise<void>;
};

/** Resolve existing auto-TTS policy before asking the native speech readiness owner for capabilities. */
export async function prepareAutomaticSpeechExpressionContext(params: {
  cfg: OpenClawConfig;
  tts: Pick<PluginRuntime["tts"], "prepareTextToSpeech">;
  preparedTtsPreferences: PreparedTtsPreferences;
  sessionAuto?: string;
  currentInboundAudio?: boolean;
  agentId?: string;
  channelId?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  runId: string;
  sessionId: string;
  assertCurrent(): void;
  commentaryEnabled: boolean;
  signal?: AbortSignal;
}): Promise<PreparedAutomaticSpeechExpressionContext | undefined> {
  if (
    !isSpeechExpressionEnabled({
      cfg: params.cfg,
      agentId: params.agentId,
      channelId: params.channelId,
      target: "voice-note",
    })
  ) {
    return undefined;
  }
  const settings = resolveTtsSettingsSnapshot({ ...params, sessionAuto: params.sessionAuto });
  if (
    settings.autoMode !== "always" &&
    !(settings.autoMode === "inbound" && params.currentInboundAudio === true)
  ) {
    return undefined;
  }
  if (resolveChannelTtsVoiceDelivery(params.channelId)?.synthesisTarget !== "voice-note") {
    return undefined;
  }
  if (!params.agentId || !params.channelId || !params.to) {
    throw new Error(
      "Automatic speech expression requires an authoritative agent and native source route",
    );
  }
  params.assertCurrent();
  const prepared = await prepareSpeechExpressionContext({
    cfg: params.cfg,
    tts: params.tts,
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
    target: "voice-note",
    currentSourceSpeechTarget: false,
    commentaryEnabled: params.commentaryEnabled,
    prefsPath: settings.prefsPath,
    timeoutMs: settings.config.timeoutMs,
    signal: params.signal,
  });
  if (!prepared) {
    throw new Error("Enabled automatic speech expression did not retain native readiness");
  }
  const assertCurrent = () => {
    params.assertCurrent();
    prepared.assertCurrent();
  };
  try {
    assertCurrent();
    if (!prepared.expectedSpeechSelection) {
      throw new Error("Automatic speech readiness did not identify its selected provider/model");
    }
    const guidance = [
      "For this admitted spoken turn, structured native message delivery takes precedence over generic progress guidance about ordinary assistant text or avoiding the message tool.",
      prepared.guidance,
      "Send requested attachments separately from spoken utterances; attachment sends retain their native non-TTS delivery.",
    ].join("\n\n");
    return {
      guidance,
      messageSpeechAdmission: {
        guidance,
        runId: params.runId,
        sessionId: params.sessionId,
        agentId: params.agentId,
        route: {
          channel: params.channelId,
          to: params.to,
          accountId: params.accountId,
          threadId: params.threadId,
        },
        assertCurrent,
        prefsPath: settings.prefsPath,
        preparedTtsPreferences: params.preparedTtsPreferences,
        sessionAuto: params.sessionAuto,
        localServiceAdmission: prepared.localServiceAdmission,
        expectedSpeechSelection: prepared.expectedSpeechSelection,
      },
      release: prepared.release,
    };
  } catch (error) {
    try {
      await prepared.release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Automatic speech admission and cleanup failed",
      );
    }
    throw error;
  }
}
