import { isDeepStrictEqual } from "node:util";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveAgentConversationMode } from "../agent-conversation-mode.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { ensureConversationKnowledgeSeed } from "./conversation-knowledge-seed.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { admitSessionConversationBranch } from "./session-conversation-admission.js";
import { enrollSessionConversationBranch } from "./session-conversation-enrollment.js";
import { resolveAgentConversationRootSessionKey } from "./session-conversation-root-key.js";
import { withSessionEntriesFromStoreInWorker } from "./session-entry-read-runtime.js";
import { captureSessionEntrySourceAssertion } from "./session-entry-source-authority.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { prepareSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/**
 * Admit the exact selected conversation, not every same-agent history. Callers
 * already own inbound/startup admission; this adds membership, never a read grant.
 */
export async function prepareSessionConversationActivation(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
}): Promise<void> {
  const mode = resolveAgentConversationMode(params.cfg, params.agentId);
  const env = captureSessionTranscriptStorageEnvironment(params.env ?? process.env);
  const configuredStore = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
    env,
  });
  if (params.cfg.session?.scope === "global") {
    if (mode === "branches") {
      throw new Error("Conversation branches require per-agent session scope");
    }
    return;
  }
  const rootSessionKey = resolveAgentConversationRootSessionKey(params);
  const check = () => {
    params.assertCurrent();
    params.signal?.throwIfAborted();
    const cfg = params.getConfig?.() ?? params.cfg;
    if (
      !listAgentIds(cfg).includes(params.agentId) ||
      cfg.session?.scope === "global" ||
      resolveAgentConversationMode(cfg, params.agentId) !== mode ||
      resolveAgentConversationRootSessionKey({ cfg, agentId: params.agentId }) !== rootSessionKey ||
      resolveSessionStorePathCore(cfg.session?.store, { agentId: params.agentId, env }) !==
        configuredStore
    ) {
      throw new Error("Conversation configuration changed before activation");
    }
  };
  check();
  await withSessionEntriesFromStoreInWorker(
    { ...params, env, sessionKeys: [params.sessionKey, rootSessionKey], projection: "full" },
    async (read) => {
      check();
      read.assertCurrent();
      const root = read.result.entries.find((row) => row.sessionKey === rootSessionKey)?.entry;
      const entry = read.result.entries.find((row) => row.sessionKey === params.sessionKey)?.entry;
      // Default native mode has no infrastructure and performs no mutation.
      if (!root && mode === "native" && !entry?.conversationTopology) {
        return;
      }
      // Creation remains the ordinary native initialization owner's responsibility.
      if (!entry) {
        return;
      }
      if (!read.result.source) {
        throw new Error("Conversation activation lost its admitted source");
      }
      const physical = await prepareSqliteTargetFromSessionStorePath(
        configuredStore,
        { agentId: params.agentId, env },
        params.signal,
      );
      check();
      read.assertCurrent();
      if (!isSameOpenClawAgentDatabasePath(read.result.source.path, physical.path)) {
        throw new Error("Conversation activation lost its configured physical store");
      }
      const original = captureSessionEntrySourceAssertion({
        scope: { ...params, env },
        readSource: read.result.source,
        expected: entry,
        fields: ["sessionId", "lifecycleRevision"],
        assertCurrent: check,
        assertHostCurrent: check,
        refuse: (): never => {
          throw new Error("Conversation changed before activation");
        },
      });
      const source = composeSessionSourceAssertion([params.assertCurrent, original]);
      const topology = admitSessionConversationBranch({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        ...(entry.conversationTopology ? { currentEntry: entry } : {}),
        rootSessionKey,
        rootEntry: root,
      });
      if (!entry.conversationTopology) {
        await enrollSessionConversationBranch({
          ...params,
          env,
          storePath: physical.path,
          expectedMode: mode,
          assertCurrent: source,
        });
      }
      source();
      const held = await loadSessionEntryForAdmission(
        { ...params, env },
        {
          assertCurrent: source,
          signal: params.signal,
        },
      );
      try {
        source();
        held.databaseClaim.assertCurrent();
        if (
          held.entry?.sessionId !== entry.sessionId ||
          held.entry.lifecycleRevision !== entry.lifecycleRevision ||
          !isDeepStrictEqual(held.entry.conversationTopology, topology)
        ) {
          throw new Error("Conversation changed after activation");
        }
        if (
          !("kind" in held.databaseClaim) ||
          held.databaseClaim.kind !== "worker" ||
          !held.databaseClaim.reader
        ) {
          throw new Error("Conversation activation requires its native reader");
        }
        await ensureConversationKnowledgeSeed({
          reader: held.databaseClaim.reader,
          sessionId: entry.sessionId,
          assertCurrent: source,
          signal: params.signal,
        });
      } finally {
        await held.databaseClaim.release();
      }
    },
  );
}
