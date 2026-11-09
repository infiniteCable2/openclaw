import { listAgentIds } from "../agents/agent-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExternalConversationTarget } from "../routing/conversation-mode.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { GatewaySessionResetParams } from "./session-create-service.types.js";
import { resolveRequestedSessionAgentInput } from "./session-request-agent.js";
import { invalidSessionRequest } from "./session-request-error.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveSessionStoreKey } from "./session-utils.js";

/** Recheck external input routing against each generation inspected during reset. */
export function createSessionResetConversationInputGuard(
  cfg: OpenClawConfig,
  agentId: string,
  params: Pick<GatewaySessionResetParams, "conversationInput">,
) {
  return (entry: SessionEntry | undefined, sessionKey: string) => {
    if (params.conversationInput) {
      assertExternalConversationTarget({ cfg, agentId, sessionKey, entry, isSystemEvent: false });
    }
  };
}

export async function resolveSessionResetTarget(
  cfg: OpenClawConfig,
  params: { key: string; agentId?: string },
) {
  const agentInput = resolveRequestedSessionAgentInput(params.key, params.agentId);
  if (!agentInput.ok) {
    return agentInput;
  }
  const explicitAgentId = agentInput.value;
  const parsedKey = parseAgentSessionKey(params.key);
  const inferredGlobalAgentId =
    !explicitAgentId &&
    parsedKey &&
    resolveSessionStoreKey({ cfg, sessionKey: params.key }) === "global"
      ? normalizeAgentId(parsedKey.agentId)
      : undefined;
  const requestedAgentId = explicitAgentId ?? inferredGlobalAgentId;
  if (requestedAgentId && !listAgentIds(cfg).includes(requestedAgentId)) {
    return invalidSessionRequest(`Unknown agent id: ${requestedAgentId}`);
  }
  if (
    explicitAgentId &&
    parsedKey?.agentId &&
    normalizeAgentId(parsedKey.agentId) !== explicitAgentId
  ) {
    return invalidSessionRequest("session key agent does not match agentId");
  }
  const lookup = {
    cfg,
    key: params.key,
    ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
  };
  const target = await resolveGatewaySessionStoreTargetInWorker(lookup);
  return { ok: true as const, cfg, target, storePath: target.storePath, requestedAgentId };
}
