import type { SessionLifecycleTimestamps } from "../../config/sessions/lifecycle.types.js";
import { resolveResetPreservedSelection } from "../../config/sessions/reset-preserved-selection.js";
import {
  evaluateSessionFreshness,
  type SessionFreshness,
  type SessionResetPolicy,
} from "../../config/sessions/reset.js";
import { preserveSessionConversationTopology } from "../../config/sessions/session-conversation-topology.js";
import { preserveSessionInheritedToolPolicy } from "../../config/sessions/session-entry-lineage.js";
import { preserveCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { selectSessionModelOverride } from "../../config/sessions/session-entry-selection.js";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry,
} from "../../config/sessions/types.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";

/** Builds the durable session fields retained across a reply-session rollover. */
export function resolveReplySessionRolloverState(
  entry: InternalSessionEntry,
  sessionKey: string,
): Partial<InternalSessionEntry> {
  const preservedSelection = resolveResetPreservedSelection({ entry });
  // Stable ACP rows predate durable creation stamps. Preserve their restrictions
  // fail-closed so rollover cannot turn an existing child into a root session.
  const preserveSpawnLineage =
    (entry.createdVia === "spawn" && Boolean(entry.spawnedBy)) ||
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey);
  return {
    ...preserveSessionConversationTopology(entry),
    thinkingLevel: entry.thinkingLevel,
    verboseLevel: entry.verboseLevel,
    traceLevel: entry.traceLevel,
    reasoningLevel: entry.reasoningLevel,
    ttsAuto: entry.ttsAuto,
    responseUsage: entry.responseUsage,
    ...selectSessionModelOverride(preservedSelection),
    communication: preservedSelection.communication,
    cyberAccessProgram: preservedSelection.cyberAccessProgram,
    authProfileOverride: preservedSelection.authProfileOverride,
    authProfileOverrideSource: preservedSelection.authProfileOverrideSource,
    authProfileOverrideCompactionCount: preservedSelection.authProfileOverrideCompactionCount,
    label: entry.label,
    autoLabel: entry.autoLabel,
    displayName: entry.displayName,
    visibility: entry.visibility,
    icon: entry.icon,
    color: entry.color,
    category: entry.category,
    sidebarRoot: entry.sidebarRoot,
    deviceFolder: entry.deviceFolder ? { ...entry.deviceFolder } : undefined,
    // Notice debt survives rollover: erasing it here would recreate the
    // silent ambiguous-loss outcome the debt exists to prevent.
    pendingDeliveryNotice: entry.pendingDeliveryNotice,
    ...(preserveSpawnLineage
      ? {
          ...preserveSessionInheritedToolPolicy(entry),
          ...(entry.inheritedToolPolicySource === "sender" && entry.sessionRoot
            ? { sessionRoot: entry.sessionRoot }
            : {}),
          spawnedBy: entry.spawnedBy,
          spawnedBySenderIsOwner: entry.spawnedBySenderIsOwner,
          spawnedBySessionId: entry.spawnedBySessionId,
          spawnedWorkspaceDir: entry.spawnedWorkspaceDir,
          spawnedCwd: entry.spawnedCwd,
          spawnDepth: entry.spawnDepth,
          subagentRole: entry.subagentRole,
          subagentControlScope: entry.subagentControlScope,
          blindPrompt: entry.blindPrompt,
        }
      : {}),
    // Native worktrees and registered projects belong to the logical session, not its
    // conversation context. Plain New Chat detaches separately through clearSpawnedCwd
    // and lifecycle cleanup.
    ...(entry.worktree || entry.projectId
      ? {
          worktree: entry.worktree,
          projectId: entry.projectId,
          spawnedCwd: entry.spawnedCwd,
          sessionRoot: entry.sessionRoot,
        }
      : {}),
    parentSessionKey: entry.parentSessionKey,
    parentSessionId: entry.parentSessionId,
    parentSessionLifecycleRevision: entry.parentSessionLifecycleRevision,
    forkedFromParent: entry.forkedFromParent,
    forkSource: entry.forkSource,
    ...preserveCreationStamp({}, entry),
    // Chat preferences survive rollover; native-runtime consent belongs to the old incarnation.
    permissionMode: entry.permissionMode,
    sandboxMode: entry.sandboxMode,
  };
}

export function resolveReplySessionFreshness(params: {
  entry: InternalSessionEntry | undefined;
  skipImplicitExpiry: boolean;
  lifecycleTimestamps: SessionLifecycleTimestamps;
  now: number;
  resetPolicy: SessionResetPolicy;
}): SessionFreshness | undefined {
  if (!params.entry) {
    return undefined;
  }
  if (params.skipImplicitExpiry) {
    return { fresh: true };
  }
  return evaluateSessionFreshness({
    updatedAt: params.entry.updatedAt,
    sessionStartedAt: params.lifecycleTimestamps.sessionStartedAt,
    lastInteractionAt: params.lifecycleTimestamps.lastInteractionAt,
    now: params.now,
    policy: params.resetPolicy,
  });
}

/** Clears last-run caches when initializing a fresh reply-session incarnation. */
export function resetReplySessionRuntimeCaches(sessionEntry: InternalSessionEntry): void {
  sessionEntry.compactionCount = 0;
  sessionEntry.memoryFlush = undefined;
  // Runtime model fields are persisted last-run cache, not user selection.
  // Reset must drop them so the next turn resolves current defaults or the
  // explicit providerOverride/modelOverride values preserved above.
  sessionEntry.modelProvider = undefined;
  sessionEntry.model = undefined;
  sessionEntry.fallbackNotice = undefined;
  sessionEntry.systemPromptReport = undefined;
  sessionEntry.startedAt = undefined;
  sessionEntry.endedAt = undefined;
  sessionEntry.runtimeMs = undefined;
  sessionEntry.status = undefined;
  // New empty transcripts have a known zero context. Parent-context forks
  // inherit history without a fresh count, so keep those explicitly unknown.
  sessionEntry.totalTokens = 0;
  sessionEntry.totalTokensFresh = true;
  sessionEntry.totalTokensVersion = SESSION_TOTAL_TOKENS_VERSION;
  sessionEntry.inputTokens = undefined;
  sessionEntry.outputTokens = undefined;
  sessionEntry.estimatedCostUsd = undefined;
  sessionEntry.cacheRead = undefined;
  sessionEntry.cacheWrite = undefined;
  sessionEntry.contextTokens = undefined;
  sessionEntry.contextTokensSource = undefined;
  sessionEntry.contextBudgetStatus = undefined;
  sessionEntry.goal = undefined;
  // Skills snapshots are prompt/runtime caches. Do not preserve a stale
  // snapshot through /new; the next turn must rebuild the visible skill list.
  sessionEntry.skillsSnapshot = undefined;
}
