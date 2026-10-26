import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../thinking.shared.js";

/** Resolve current native selection; an old turn supplies data, never execution custody. */
export function resolveIdleConversationKnowledgeProfile(params: {
  branch: ConversationKnowledgeBranch;
  entry: InternalSessionEntry;
  cfg: OpenClawConfig;
  run?: RunEmbeddedAgentParams;
}): RunEmbeddedAgentParams {
  const { branch, entry, cfg } = params;
  const selected = resolveSessionModelRef(cfg, entry, branch.agentId, {
    allowPluginNormalization: false,
  });
  const baseline =
    params.run?.provider === selected.provider && params.run.model === selected.model
      ? params.run
      : undefined;
  const authProfileId = entry.authProfileOverride?.trim() || baseline?.authProfileId;
  return {
    agentId: branch.agentId,
    sessionId: branch.sessionId,
    sessionKey: branch.sessionKey,
    sessionFile: branch.sessionKey,
    config: cfg,
    prompt: "",
    // The native summary owner uses this for diagnostics, not an operational run claim.
    runId: params.run?.runId ?? branch.sessionId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, branch.agentId),
    agentDir: resolveAgentDir(cfg, branch.agentId),
    timeoutMs: resolveAgentTimeoutMs({ cfg }),
    provider: selected.provider,
    model: selected.model,
    authProfileId,
    authProfileIdSource: entry.authProfileOverride
      ? resolveCollapsedSessionAuthPinSource(entry)
      : baseline?.authProfileIdSource,
    contextTokenBudget: baseline?.contextTokenBudget,
    agentHarnessId: resolveSessionPinnedHarnessId(entry) ?? baseline?.agentHarnessId,
    modelSelectionLocked: entry.modelSelectionLocked ?? baseline?.modelSelectionLocked,
    thinkLevel: normalizeThinkLevel(entry.thinkingLevel) ?? baseline?.thinkLevel,
    reasoningLevel: normalizeReasoningLevel(entry.reasoningLevel) ?? baseline?.reasoningLevel,
    disableTools: true,
    modelFallbacksOverride: [],
  };
}
