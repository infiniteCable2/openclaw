import {
  normalizeAgentId,
  parseAgentSessionKey,
  isSubagentSessionKey,
} from "../../routing/session-key.js";
import {
  captureSessionConversationTopology,
  type SessionConversationTopology,
} from "./session-conversation-topology.js";
import { resolveSessionWorkStartError } from "./session-work-start.js";
import type { InternalSessionEntry } from "./types.js";

/** The Host creation and branch admission owners share this private infrastructure contract. */
export function assertSessionConversationRootEntry(
  root: InternalSessionEntry | undefined,
  sessionKey: string,
): asserts root is InternalSessionEntry & { lifecycleRevision: string } {
  if (
    !root ||
    captureSessionConversationTopology(root.conversationTopology)?.role !== "root" ||
    root.createdVia !== "internal" ||
    root.createdActor?.type !== "system" ||
    root.createdActor.id !== "conversation-root" ||
    root.visibility !== "draft" ||
    root.publicShare !== undefined ||
    root.delivery?.kind !== "none" ||
    root.parentSessionKey !== undefined ||
    root.parentSessionId !== undefined ||
    root.parentSessionLifecycleRevision !== undefined ||
    root.spawnedBy !== undefined ||
    root.spawnedBySessionId !== undefined ||
    root.spawnDepth !== undefined ||
    root.forkSource !== undefined ||
    root.forkedFromParent === true ||
    root.owner !== undefined ||
    (root.participantCount ?? 0) !== 0 ||
    (root.participants?.length ?? 0) !== 0 ||
    root.incognito ||
    resolveSessionWorkStartError(sessionKey, root) !== undefined ||
    !root.sessionId.trim() ||
    !root.lifecycleRevision?.trim()
  ) {
    throw new Error(
      "Conversation root is not admitted. Initialize or explicitly migrate the agent root before enabling branches.",
    );
  }
}

/** Bind conversation membership, never source-history or task-control authority. */
export function admitSessionConversationBranch(params: {
  agentId: string;
  sessionKey: string;
  currentEntry?: InternalSessionEntry;
  rootSessionKey: string;
  rootEntry: InternalSessionEntry | undefined;
}): Extract<SessionConversationTopology, { role: "branch" }> {
  const agentId = normalizeAgentId(params.agentId);
  if (
    parseAgentSessionKey(params.rootSessionKey)?.agentId !== agentId ||
    parseAgentSessionKey(params.sessionKey)?.agentId !== agentId ||
    params.sessionKey === params.rootSessionKey ||
    isSubagentSessionKey(params.sessionKey)
  ) {
    throw new Error("A conversation branch requires its own same-agent, non-task target.");
  }
  const root = params.rootEntry;
  assertSessionConversationRootEntry(root, params.rootSessionKey);
  const selected: Extract<SessionConversationTopology, { role: "branch" }> = {
    version: 1,
    role: "branch",
    rootSessionKey: params.rootSessionKey,
    rootSessionId: root.sessionId,
    rootSessionLifecycleRevision: root.lifecycleRevision,
  };
  if (params.currentEntry) {
    const current = captureSessionConversationTopology(params.currentEntry.conversationTopology);
    if (!current) {
      throw new Error(
        "An existing conversation requires explicit branch admission; its history has not been migrated.",
      );
    }
    if (JSON.stringify(current) !== JSON.stringify(selected)) {
      throw new Error(
        "Conversation root incarnation changed; explicit branch reconciliation is required.",
      );
    }
  }
  return selected;
}
