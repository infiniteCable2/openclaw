import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { buildAgentMainSessionKey } from "@openclaw/session-url-contract";
import type { OpenClawConfig } from "../types.openclaw.js";

/** Internal consolidation identity, independent of native main-session routing. */
export function resolveAgentConversationRootSessionKey(params: {
  cfg?: Pick<OpenClawConfig, "session">;
  agentId: string;
}): string {
  const sessionKey = `agent:${normalizeAgentId(params.agentId)}:internal:conversation-root`;
  if (
    buildAgentMainSessionKey({
      agentId: params.agentId,
      mainKey: params.cfg?.session?.mainKey,
    }) === sessionKey
  ) {
    throw new Error("session.mainKey collides with the reserved internal conversation root");
  }
  return sessionKey;
}
