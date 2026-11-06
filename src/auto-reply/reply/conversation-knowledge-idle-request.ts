import { isDeepStrictEqual } from "node:util";
import {
  resolveAgentConfig,
  resolveAgentRunCwd,
  resolveAgentWorkspaceDir,
  resolveEffectiveAgentDir,
} from "../../agents/agent-scope-config.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "../../agents/embedded-agent-runner/compact.types.js";
import { MissingAgentHarnessError } from "../../agents/harness/errors.js";
import { resolveAgentHarnessSelectionDecision } from "../../agents/harness/selection-decision.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOperatorRoleSelection } from "../../gateway/operator-role-policy.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";

type IdleMaintenanceRequestContext = {
  config: OpenClawConfig;
  entry: InternalSessionEntry;
  branch: ConversationKnowledgeBranch;
};

/** Additional model/placement restriction; the caller still holds native source custody. */
export function hasIdleConversationKnowledgeMaintenanceModelAuthority(
  params: IdleMaintenanceRequestContext,
): boolean {
  const { config, entry, branch } = params;
  if (!config.gateway?.roles) {
    return true;
  }
  const enrollment = entry.conversationRecipientEnrollment;
  if (!enrollment || !isDeepStrictEqual(enrollment.branch, branch)) {
    return false;
  }
  const original = enrollment.source.snapshot;
  const selected = resolveOperatorRoleSelection(
    original.profileId,
    original.assignedRole,
    config,
    original.githubLogin,
  );
  const role = selected.effectiveRole
    ? config.gateway.roles.definitions[selected.effectiveRole]
    : undefined;
  // Source custody requalifies the principal, but deliberately excludes model
  // ceilings. A foreground footprint also does not authorize compaction.model.
  return role !== undefined && !role.modelPolicy && role.sandbox !== "required";
}

/**
 * Resolve this maintenance operation's placement, never a restored foreground
 * footprint or a source grant. The admitted idle owner retains current audience,
 * model/config, transcript-version and writer custody around every native call.
 */
export function resolveIdleConversationKnowledgeMaintenanceRequest(
  params: IdleMaintenanceRequestContext,
): CompactEmbeddedAgentSessionRuntimeParams | undefined {
  const { config, entry, branch } = params;
  const agent = resolveAgentConfig(config, branch.agentId);
  if (
    !agent ||
    entry.sessionId !== branch.sessionId ||
    entry.lifecycleRevision !== branch.lifecycleRevision ||
    entry.incognito ||
    entry.archivedAt !== undefined ||
    entry.publicShare ||
    entry.repositoryWorkspaceId ||
    entry.worktree ||
    entry.spawnedBy ||
    entry.spawnedWorkspaceDir ||
    entry.spawnedCwd ||
    entry.sessionRoot ||
    entry.sandbox ||
    entry.sandboxMode ||
    entry.execNode ||
    entry.execHost ||
    entry.execCwd ||
    entry.authProfileOverride ||
    entry.authProfileOverrideSource ||
    entry.pluginOwnerId ||
    config.cloudWorkers?.requiredProfile ||
    agent.runtime?.type === "acp" ||
    (agent.sandbox?.mode && agent.sandbox.mode !== "off") ||
    (config.agents?.defaults?.sandbox?.mode && config.agents.defaults.sandbox.mode !== "off") ||
    (config.plugins?.slots?.contextEngine && config.plugins.slots.contextEngine !== "legacy")
  ) {
    return undefined;
  }
  if (!hasIdleConversationKnowledgeMaintenanceModelAuthority(params)) {
    return undefined;
  }
  const model = resolveSessionModelRef(config, entry, branch.agentId, {
    allowPluginNormalization: false,
  });
  // Cold maintenance supports explicit current model declarations, not a guessed
  // built-in default or a model/window observed by a previous foreground run.
  if (!config.models?.providers?.[model.provider]?.models.some((row) => row.id === model.model)) {
    return undefined;
  }
  try {
    const harness = resolveAgentHarnessSelectionDecision({
      config,
      agentId: branch.agentId,
      sessionKey: branch.sessionKey,
      provider: model.provider,
      modelId: model.model,
      agentHarnessId: resolveSessionPinnedHarnessId(entry),
      agentHarnessRuntimeOverride: entry.agentRuntimeOverride,
    });
    if (!harness.builtIn) {
      return undefined;
    }
    return {
      config,
      ...model,
      sessionTarget: branch,
      sessionId: branch.sessionId,
      sessionKey: branch.sessionKey,
      agentId: branch.agentId,
      agentHarnessId: harness.selectedHarnessId,
      workspaceDir: resolveAgentWorkspaceDir(config, branch.agentId),
      cwd: resolveAgentRunCwd(config, branch.agentId),
      agentDir: resolveEffectiveAgentDir(config, branch.agentId),
      permissionMode: entry.permissionMode,
      disableTools: true,
      modelFallbacksOverride: [],
      trigger: "budget",
    };
  } catch (error) {
    if (!(error instanceof MissingAgentHarnessError)) {
      throw error;
    }
    return undefined;
  }
}
