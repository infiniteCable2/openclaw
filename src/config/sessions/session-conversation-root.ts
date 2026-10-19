import { randomUUID } from "node:crypto";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import { captureAgentDatabaseAdmission } from "../../state/agent-database-admission.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveAgentConversationMode } from "../agent-conversation-mode.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { assertSessionConversationRootEntry } from "./session-conversation-admission.js";
import { resolveAgentConversationRootSessionKey } from "./session-conversation-root-key.js";
import { createSessionEntryWithTranscriptIfAbsent } from "./session-entry-creation.js";
import { buildSessionCreationStamp } from "./session-entry-provenance.js";
import { prepareSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { InternalSessionEntry } from "./types.js";

type ExistingRoot = { kind: "existing-root"; entry: InternalSessionEntry };

/** Host-configured infrastructure only: no inbound identity, history import, or delivery grant. */
export async function ensureAgentConversationRoot(params: {
  cfg: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  admittedStorePath?: string;
  getConfig?: () => OpenClawConfig;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}): Promise<{ sessionKey: string; entry: InternalSessionEntry; created: boolean }> {
  if (params.cfg.session?.scope === "global") {
    throw new Error("Conversation branches require per-agent session scope, not global scope");
  }
  const env = captureSessionTranscriptStorageEnvironment(params.env ?? process.env);
  const sessionKey = resolveAgentConversationRootSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
    env,
  });
  const assertAdmitted = captureAgentDatabaseAdmission(params.agentId, { env });
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    assertAdmitted();
    const current = params.getConfig?.() ?? params.cfg;
    if (
      !listAgentIds(current).includes(params.agentId) ||
      current.session?.scope === "global" ||
      resolveAgentConversationMode(current, params.agentId) !== "branches" ||
      resolveAgentConversationRootSessionKey({ cfg: current, agentId: params.agentId }) !==
        sessionKey ||
      resolveSessionStorePathCore(current.session?.store, { agentId: params.agentId, env }) !==
        storePath
    ) {
      throw new Error("Conversation root configuration changed during host admission");
    }
  };
  assertCurrent();
  const selectedStore = await prepareSqliteTargetFromSessionStorePath(
    storePath,
    { agentId: params.agentId, env },
    params.signal,
  );
  assertCurrent();
  if (
    params.admittedStorePath &&
    !isSameOpenClawAgentDatabasePath(params.admittedStorePath, selectedStore.path)
  ) {
    throw new Error("Conversation root lost its admitted physical session store");
  }
  // A fresh suffix becomes an exact locator here; retain its prepared physical owner.
  const result = await createSessionEntryWithTranscriptIfAbsent<ExistingRoot>(
    {
      agentId: params.agentId,
      defaultAgentId: selectedStore.agentId,
      sessionKey,
      storePath: selectedStore.path,
      env,
    },
    ({ existingEntry, targetEntry }) => {
      assertCurrent();
      if (existingEntry || targetEntry) {
        if (!targetEntry || existingEntry?.sessionId !== targetEntry.sessionId) {
          throw new Error(
            `Conversation root ${sessionKey} resolves through a legacy alias. Explicitly migrate it before enabling branches.`,
          );
        }
        assertSessionConversationRootEntry(targetEntry, sessionKey);
        // A negative preparation result deliberately performs no row/header update.
        return { ok: false, error: { kind: "existing-root", entry: targetEntry } };
      }
      const now = Date.now();
      return {
        ok: true,
        entry: {
          sessionId: randomUUID(),
          lifecycleRevision: randomUUID(),
          updatedAt: now,
          ...buildSessionCreationStamp({
            via: "internal",
            actor: { type: "system", id: "conversation-root" },
            now,
          }),
          visibility: "draft",
          delivery: { kind: "none" },
          conversationTopology: { version: 1, role: "root" },
        },
      };
    },
    { commitGuard: assertCurrent, requireWriteSuccess: true },
  );
  assertCurrent();
  if (result.ok) {
    return { sessionKey, entry: result.entry, created: true };
  }
  if (result.phase === "entry") {
    return { sessionKey, entry: result.error.entry, created: false };
  }
  throw new Error(`Conversation root transcript initialization failed: ${result.error}`);
}
