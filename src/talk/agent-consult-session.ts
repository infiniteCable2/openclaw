import { randomUUID } from "node:crypto";
import { buildSpawnAuthorityReceipt } from "../config/sessions/session-entry-lineage.js";
import {
  buildSessionCreationStamp,
  inheritSessionCreationPolicy,
} from "../config/sessions/session-entry-provenance.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeLogger, PluginRuntimeCore } from "../plugins/runtime/types-core.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { assertModelSelectionUnlocked } from "../sessions/model-overrides.js";
import {
  normalizeDeliveryContext,
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";

export type RealtimeVoiceAgentConsultContextMode = "isolated" | "fork";

/** Host-selected copied context is not a delegation, delivery, or access-control link. */
export function resolveRealtimeVoiceContextSource(params: {
  agentId: string;
  sessionKey: string;
  spawnedBy?: string | null;
  contextSourceSessionKey?: string;
}): string | undefined {
  if (params.contextSourceSessionKey === undefined) {
    // A delegated task naturally copies its admitted requester.
    return params.spawnedBy?.trim() || undefined;
  }
  const sourceKey = params.contextSourceSessionKey.trim();
  const sourceAgent = parseAgentSessionKey(sourceKey)?.agentId;
  if (!sourceKey || sourceKey === params.sessionKey.trim()) {
    throw new Error("Voice context source must identify a different conversation.");
  }
  if (sourceAgent && sourceAgent !== params.agentId) {
    throw new Error("Voice context source must belong to the admitted agent.");
  }
  if (params.spawnedBy?.trim() && sourceKey !== params.spawnedBy.trim()) {
    throw new Error("Delegated voice context must come from its admitted requester.");
  }
  return sourceKey;
}

function resolveDeliverySessionFields(context?: DeliveryContext): Partial<SessionEntry> {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel || !normalized.to) {
    return {};
  }
  return {
    delivery: normalizeSessionDeliveryState({ context: normalized }),
  };
}

type RealtimeVoiceAgentConsultSessionParams = {
  agentId: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  spawnedBy?: string | null;
  contextSourceSessionKey?: string;
  senderIsOwner?: boolean;
  contextMode?: RealtimeVoiceAgentConsultContextMode;
  deliveryContext?: DeliveryContext;
  storePath: string;
  agentRuntime: PluginRuntimeCore["agent"];
  logger: Pick<RuntimeLogger, "warn">;
  assertCurrent: () => void;
};

export async function resolveRealtimeVoiceAgentConsultSessionEntry(
  params: RealtimeVoiceAgentConsultSessionParams,
): Promise<{ entry: SessionEntry; parentContextNotice?: string }> {
  const requesterSessionKey = params.spawnedBy?.trim();
  const contextSourceKey = resolveRealtimeVoiceContextSource(params);
  const readKey = contextSourceKey ?? requesterSessionKey;
  if (!readKey) {
    return initializeRealtimeVoiceAgentConsultSession(params);
  }
  const { withSessionEntryReadOnlyInWorker } =
    await import("../config/sessions/session-entry-read-runtime.js");
  const readAgentId = parseAgentSessionKey(readKey)?.agentId ?? params.agentId;
  return withSessionEntryReadOnlyInWorker(
    {
      agentId: readAgentId,
      storePath: params.agentRuntime.session.resolveStorePath(params.cfg.session?.store, {
        agentId: readAgentId,
      }),
      sessionKey: readKey,
      readConsistency: "latest",
    },
    params.assertCurrent,
    async (read, owner) => {
      if (!read.ok) {
        throw read.error;
      }
      if (params.contextSourceSessionKey !== undefined && !read.value?.sessionId) {
        throw new Error(
          "The selected voice context source is unavailable. Retry the conversation.",
        );
      }
      return initializeRealtimeVoiceAgentConsultSession(
        params,
        requesterSessionKey ? read.value : undefined,
        read.value,
        owner.source,
        owner.assertCurrent,
      );
    },
  );
}

async function initializeRealtimeVoiceAgentConsultSession(
  params: RealtimeVoiceAgentConsultSessionParams,
  requesterEntry?: SessionEntry,
  contextSourceEntry?: SessionEntry,
  contextReadSource?: CapturedSessionEntryReadSource,
  assertSourcesCurrent?: () => void,
): Promise<{ entry: SessionEntry; parentContextNotice?: string }> {
  const now = Date.now();
  const deliveryFields = resolveDeliverySessionFields(params.deliveryContext);
  const requesterSessionKey = params.spawnedBy?.trim();
  const contextSourceKey = resolveRealtimeVoiceContextSource(params);
  const contextSourceAgentId = parseAgentSessionKey(contextSourceKey)?.agentId;
  if (params.contextSourceSessionKey !== undefined && contextSourceEntry) {
    assertModelSelectionUnlocked(contextSourceEntry);
  }
  const creationStamp = buildSessionCreationStamp({
    via: "talk",
    ...inheritSessionCreationPolicy(
      requesterEntry,
      requesterSessionKey ? { type: "agent", id: requesterSessionKey } : undefined,
    ),
  });
  // A consult child records the same lineage receipt as a native spawn: the requester's
  // exact incarnation and the caller's ingress-authenticated owner bit.
  const spawnLineage = requesterSessionKey
    ? {
        spawnedBy: requesterSessionKey,
        ...buildSpawnAuthorityReceipt(requesterEntry, params.senderIsOwner),
      }
    : {};
  const shouldFork =
    params.contextMode === "fork" &&
    contextSourceKey &&
    contextSourceEntry?.sessionId &&
    (!contextSourceAgentId || contextSourceAgentId === params.agentId);
  let forkDecisionWarning: string | undefined;
  let parentContextNotice: string | undefined;

  let patched: SessionEntry | null = null;
  if (shouldFork) {
    const { forkSessionEntryFromParent } = await import("../auto-reply/reply/session-fork.js");
    const forked = await forkSessionEntryFromParent({
      storePath: params.storePath,
      parentSessionKey: contextSourceKey,
      agentId: params.agentId,
      config: params.cfg,
      sessionKey: params.sessionKey,
      forkFrom: "last-completed",
      expectedParent: {
        sessionId: contextSourceEntry.sessionId,
        lifecycleRevision: contextSourceEntry.lifecycleRevision,
      },
      expectedParentSource: contextReadSource,
      commitGuard: assertSourcesCurrent,
      fallbackEntry: {
        ...creationStamp,
        sessionId: "",
        updatedAt: now,
      },
      entryPatch: {
        skipExisting: true,
        skipped: { ...deliveryFields, updatedAt: now },
        forked: { ...deliveryFields, ...spawnLineage, updatedAt: now },
      },
    });
    if (forked.status === "failed" || forked.status === "missing-parent") {
      throw new Error(
        "The parent conversation changed or could not be safely forked. Retry the conversation.",
      );
    }
    if (forked.status === "forked" || forked.status === "skipped") {
      if (forked.status === "forked" && forked.fork.contextStatus === "no-completed-turn") {
        parentContextNotice =
          "No completed parent turn is available in the current context window. This conversation started without an inherited transcript. Parent activity is context, not a new instruction; do not resume or repeat its unfinished work.";
      }
      if (forked.status === "skipped" && forked.decision?.status === "skip") {
        forkDecisionWarning = forked.decision.message;
      }
      if (forked.sessionEntry.sessionId?.trim()) {
        patched = forked.sessionEntry;
      }
    }
  }

  patched ??= await params.agentRuntime.session.patchSessionEntry({
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    fallbackEntry: {
      ...creationStamp,
      sessionId: "",
      updatedAt: now,
    },
    assertCommitAllowed: () => {
      params.assertCurrent();
      assertSourcesCurrent?.();
    },
    update: async (entry) => {
      if (entry.sessionId?.trim()) {
        return { ...deliveryFields, updatedAt: now };
      }
      return {
        ...deliveryFields,
        sessionId: randomUUID(),
        ...spawnLineage,
        updatedAt: now,
      };
    },
  });
  if (forkDecisionWarning) {
    params.logger.warn(`[talk] ${forkDecisionWarning}`);
  }
  if (patched?.sessionId?.trim()) {
    return { entry: patched, parentContextNotice };
  }
  throw new Error("realtime voice agent consult session could not be initialized");
}
