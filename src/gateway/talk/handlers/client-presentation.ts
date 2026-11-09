import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { projectInternalRealtimeVoicePublicConfig } from "../../../talk/provider-internal.js";
import type { ResolvedRealtimeVoiceProvider } from "../../../talk/provider-resolver.js";
import type { RealtimeVoiceBrowserSession } from "../../../talk/provider-types.js";
import { registerTalkVoiceSession } from "../voice-selection.js";

/** Publish only native public provider metadata and retain the call's voice selection owner. */
export function registerTalkClientPresentation(
  params: Omit<Parameters<typeof registerTalkVoiceSession>[0], "selection" | "launch"> & {
    session: RealtimeVoiceBrowserSession;
    resolution: ResolvedRealtimeVoiceProvider;
    canChangeVoice: boolean;
    signal: AbortSignal;
  },
) {
  const { session, resolution } = params;
  const model =
    normalizeOptionalString(session.model) ??
    normalizeOptionalString(resolution.providerConfig.model) ??
    resolution.provider.defaultModel;
  const voice =
    normalizeOptionalString(session.voice) ??
    normalizeOptionalString(resolution.providerConfig.voice);
  const publicSession = projectInternalRealtimeVoicePublicConfig({
    provider: resolution.provider,
    providerConfig: resolution.providerConfig,
    config: { ...session, model, voice },
  });
  const voices = [
    ...(resolution.capabilities?.voices ??
      (model ? resolution.capabilities?.voicesByModel?.[model] : undefined) ??
      resolution.provider.voices ??
      []),
  ];
  const unregister = registerTalkVoiceSession({
    voiceSessionId: params.voiceSessionId,
    connId: params.connId,
    sessionTarget: params.sessionTarget,
    selection: {
      provider: session.provider,
      model: publicSession.model,
      voice: publicSession.voice,
      voices,
      canChange: params.canChangeVoice && voices.length > 0,
    },
    launch: { provider: session.provider, model },
    voiceChangeId: params.voiceChangeId,
    providerReady: params.providerReady,
  });
  params.signal.addEventListener("abort", unregister, { once: true });
  if (params.signal.aborted) {
    unregister();
  }
  return { publicSession, unregister };
}
