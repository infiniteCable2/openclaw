import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import {
  resolveSessionStoreCompatibilityAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** The same logical-routing snapshot for prepared sharing readers and mutations. */
export function readSessionSharingRoutingFacts(cfg: OpenClawConfig) {
  return {
    agents: listAgentIds(cfg),
    storeOwner: resolveSessionStoreCompatibilityAgentId(cfg),
    compatibilityOwner: tryResolveLegacyCompatibilityAgentId(cfg),
    systemOwner: tryResolveAmbientOwnerAgentId(cfg),
    store: cfg.session?.store,
    mainKey: cfg.session?.mainKey,
    scope: cfg.session?.scope,
  };
}
