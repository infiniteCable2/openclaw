import type { ThinkLevel } from "../../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";

export type TalkSpeechAgentOverrides = {
  thinking?: ThinkLevel;
  fastMode?: boolean;
};

function ownEntry<T>(entries: Record<string, T> | undefined, key: string): T | undefined {
  return entries && Object.hasOwn(entries, key) ? entries[key] : undefined;
}

/** Resolve only host-admitted speech scope against the actual selected provider. */
export function resolveTalkSpeechAgentOverrides(params: {
  config: Pick<OpenClawConfig, "talk">;
  agentId: string;
  channelId: string;
  provider: string;
}): TalkSpeechAgentOverrides | undefined {
  for (const id of [params.agentId, params.channelId, params.provider]) {
    if (!id || id !== id.trim() || isBlockedObjectKey(id)) {
      return undefined;
    }
  }
  const profile = ownEntry(params.config.talk?.speech?.agentProfiles, params.agentId);
  const channel = ownEntry(profile?.agentOverrides?.channels, params.channelId);
  const overrides = ownEntry(channel?.providers, params.provider);
  if (!overrides) {
    return undefined;
  }
  // A fresh projection cannot mutate configuration or acquire another scope.
  return {
    ...(Object.hasOwn(overrides, "thinking") ? { thinking: overrides.thinking } : {}),
    ...(Object.hasOwn(overrides, "fastMode") ? { fastMode: overrides.fastMode } : {}),
  };
}
