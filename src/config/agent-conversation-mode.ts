import { listAgentIds, resolveAgentEntry } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Conversation organization never grants tool, identity, or delivery authority. */
export function resolveAgentConversationMode(cfg: OpenClawConfig, agentId: string) {
  return resolveAgentEntry(cfg, agentId)?.conversationMode ?? "native";
}

/** Deterministic admission/cache identity, including supported in-place config edits. */
export function resolveAgentConversationModeContract(cfg: OpenClawConfig): string {
  return JSON.stringify(
    listAgentIds(cfg)
      .filter((agentId) => resolveAgentConversationMode(cfg, agentId) === "branches")
      .toSorted(),
  );
}
