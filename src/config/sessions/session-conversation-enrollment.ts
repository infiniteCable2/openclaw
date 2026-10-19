import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import {
  isCronSessionKey,
  isAcpSessionKey,
  isIncognitoSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { captureAgentDatabaseAdmission } from "../../state/agent-database-admission.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveAgentConversationMode } from "../agent-conversation-mode.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { admitSessionConversationBranch } from "./session-conversation-admission.js";
import { resolveAgentConversationRootSessionKey } from "./session-conversation-root-key.js";
import { captureSessionConversationTopology } from "./session-conversation-topology.js";
import {
  readSessionEntrySummariesInWorker,
  withSessionEntriesFromStoreInWorker,
} from "./session-entry-read-runtime.js";
import { captureSessionEntrySourceAssertion } from "./session-entry-source-authority.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { prepareSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { resolveSessionWorkStartError } from "./session-work-start.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { InternalSessionEntry } from "./types.js";

function isEligibleConversation(
  entry: InternalSessionEntry | undefined,
  sessionKey: string,
  allowMissingRevision = false,
): entry is InternalSessionEntry {
  if (
    !entry ||
    !entry.sessionId.trim() ||
    (!entry.lifecycleRevision?.trim() &&
      !(allowMissingRevision && entry.lifecycleRevision === undefined)) ||
    entry.incognito ||
    entry.parentSessionKey !== undefined ||
    entry.parentSessionId !== undefined ||
    entry.parentSessionLifecycleRevision !== undefined ||
    entry.spawnedBy !== undefined ||
    entry.spawnedBySessionId !== undefined ||
    entry.spawnDepth !== undefined ||
    entry.forkSource !== undefined ||
    entry.forkedFromParent === true ||
    entry.createdVia === "spawn" ||
    entry.createdVia === "cron" ||
    entry.subagentRole !== undefined ||
    entry.cronRunContinuation !== undefined ||
    entry.heartbeatIsolatedBaseSessionKey !== undefined ||
    resolveSessionWorkStartError(sessionKey, entry) !== undefined
  ) {
    return false;
  }
  return true;
}

/** Startup only: establish legacy identities before ingress can retain revision-bound claims. */
export async function prepareConversationLifecyclesForStartup(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  agentId: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
}): Promise<void> {
  const env = captureSessionTranscriptStorageEnvironment(params.env ?? process.env);
  const configuredStore = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
    env,
  });
  const check = () => {
    params.assertCurrent();
    params.signal?.throwIfAborted();
    const cfg = params.getConfig?.() ?? params.cfg;
    if (
      !listAgentIds(cfg).includes(params.agentId) ||
      cfg.session?.scope === "global" ||
      resolveAgentConversationMode(cfg, params.agentId) !== "branches" ||
      resolveSessionStorePathCore(cfg.session?.store, { agentId: params.agentId, env }) !==
        configuredStore
    ) {
      throw new Error("Conversation startup configuration changed before lifecycle initialization");
    }
  };
  check();
  const physical = await prepareSqliteTargetFromSessionStorePath(
    configuredStore,
    { agentId: params.agentId, env },
    params.signal,
  );
  check();
  if (!isSameOpenClawAgentDatabasePath(params.storePath, physical.path)) {
    throw new Error("Conversation startup lost its admitted physical session store");
  }
  const scope = { agentId: params.agentId, storePath: physical.path, env };
  const summaries = await readSessionEntrySummariesInWorker(scope);
  check();
  for (const { sessionKey, entry: summary } of summaries) {
    if (
      summary.lifecycleRevision !== undefined ||
      parseAgentSessionKey(sessionKey)?.agentId !== params.agentId ||
      isSubagentSessionKey(sessionKey) ||
      isCronSessionKey(sessionKey) ||
      isIncognitoSessionKey(sessionKey) ||
      isAcpSessionKey(sessionKey) ||
      sessionKey === resolveAgentConversationRootSessionKey(params)
    ) {
      continue;
    }
    await withSessionEntriesFromStoreInWorker(
      { ...scope, sessionKeys: [sessionKey], projection: "full", includeAuthorization: true },
      async (read) => {
        check();
        read.assertCurrent();
        const entry = read.result.entries.find((row) => row.sessionKey === sessionKey)?.entry;
        if (
          !isEligibleConversation(entry, sessionKey, true) ||
          entry.lifecycleRevision !== undefined ||
          entry.conversationTopology
        ) {
          return;
        }
        const identity = read.result.databaseIdentity;
        if (!identity) {
          throw new Error("Conversation startup lost its admitted lifecycle source");
        }
        const source = captureSessionEntrySourceAssertion({
          scope: { ...scope, sessionKey },
          readSource: {
            agentId: read.database.agentId,
            path: read.database.path,
            databaseIdentity: identity.identity,
            databaseBirthtime: identity.birthtime,
          },
          expected: entry,
          fields: ["sessionId", "lifecycleRevision"],
          assertCurrent: check,
          assertHostCurrent: check,
          refuse: (): never => {
            throw new Error("Conversation changed before startup lifecycle initialization");
          },
        });
        await applySessionEntryLifecycleMutation({
          ...scope,
          activeSessionKey: sessionKey,
          skipMaintenance: true,
          source: composeSessionSourceAssertion([params.assertCurrent, source]),
          commitGuard: check,
          upserts: [
            {
              sessionKey,
              buildEntry({ currentEntry }) {
                if (!sqliteSessionEntriesEqual(currentEntry, entry)) {
                  throw new Error("Conversation changed before startup lifecycle initialization");
                }
                return { ...entry, lifecycleRevision: randomUUID() };
              },
            },
          ],
        });
        check();
      },
    );
  }
}

/** Explicit metadata-only enrollment; membership never grants history, identity or delivery access. */
export async function enrollSessionConversationBranch(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  agentId: string;
  sessionKey: string;
  /** Exact admitted physical store, not an unverified replacement locator. */
  storePath: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  /** An explicit native-mode transition may retain membership without activating branch routing. */
  expectedMode?: "native" | "branches";
}): Promise<{ entry: InternalSessionEntry; enrolled: boolean }> {
  const agentId = normalizeAgentId(params.agentId);
  const sessionKey = params.sessionKey;
  const cfg = params.cfg;
  const storePath = params.storePath;
  const signal = params.signal;
  const originalSource = params.assertCurrent;
  const getConfig = params.getConfig?.bind(params);
  const env = captureSessionTranscriptStorageEnvironment(params.env ?? process.env);
  const expectedMode = params.expectedMode ?? "branches";
  const rootSessionKey = resolveAgentConversationRootSessionKey({ cfg, agentId });
  if (
    sessionKey !== sessionKey.trim() ||
    parseAgentSessionKey(sessionKey)?.agentId !== agentId ||
    sessionKey === rootSessionKey ||
    isSubagentSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey) ||
    isIncognitoSessionKey(sessionKey)
  ) {
    throw new Error("Conversation enrollment requires an exact same-agent, non-task target.");
  }
  const configuredStore = resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
  const assertAdmitted = captureAgentDatabaseAdmission(agentId, { env });
  const assertConfigCurrent = () => {
    signal?.throwIfAborted();
    assertAdmitted();
    const currentConfig = getConfig?.() ?? cfg;
    if (
      !listAgentIds(currentConfig).includes(agentId) ||
      currentConfig.session?.scope === "global" ||
      resolveAgentConversationMode(currentConfig, agentId) !== expectedMode ||
      resolveAgentConversationRootSessionKey({ cfg: currentConfig, agentId }) !== rootSessionKey ||
      resolveSessionStorePathCore(currentConfig.session?.store, { agentId, env }) !==
        configuredStore
    ) {
      throw new Error("Conversation enrollment configuration changed during admission.");
    }
  };
  assertConfigCurrent();
  originalSource();
  const selected = await prepareSqliteTargetFromSessionStorePath(
    configuredStore,
    { agentId, env },
    signal,
  );
  assertConfigCurrent();
  originalSource();
  if (!isSameOpenClawAgentDatabasePath(storePath, selected.path)) {
    throw new Error("Conversation enrollment lost its admitted physical session store.");
  }
  return withSessionEntriesFromStoreInWorker(
    {
      agentId,
      storePath: selected.path,
      env,
      sessionKeys: [sessionKey, rootSessionKey],
      projection: "full",
      includeAuthorization: true,
    },
    async (read) => {
      assertConfigCurrent();
      originalSource();
      read.assertCurrent();
      const identity = read.result.databaseIdentity;
      const source = identity && {
        agentId: read.database.agentId,
        path: read.database.path,
        databaseIdentity: identity.identity,
        databaseBirthtime: identity.birthtime,
      };
      if (
        !source ||
        source.agentId !== agentId ||
        !isSameOpenClawAgentDatabasePath(source.path, selected.path)
      ) {
        throw new Error("Conversation enrollment requires its original admitted store reader.");
      }
      const entry = read.result.entries.find((row) => row.sessionKey === sessionKey)?.entry;
      if (!isEligibleConversation(entry, sessionKey)) {
        throw new Error("Conversation enrollment requires an existing live, non-task session.");
      }
      const topology = admitSessionConversationBranch({
        agentId,
        sessionKey,
        rootSessionKey,
        rootEntry: read.result.entries.find((row) => row.sessionKey === rootSessionKey)?.entry,
      });
      const current = captureSessionConversationTopology(entry.conversationTopology);
      if (current) {
        if (!isDeepStrictEqual(current, topology)) {
          throw new Error("Conversation enrollment cannot rebind existing topology.");
        }
        return { entry, enrolled: false };
      }
      const retained = captureSessionEntrySourceAssertion({
        scope: { agentId, sessionKey, storePath: selected.path, env },
        readSource: source,
        expected: entry,
        fields: ["sessionId", "lifecycleRevision", "conversationTopology"],
        assertCurrent: assertConfigCurrent,
        assertHostCurrent: assertConfigCurrent,
        refuse: (): never => {
          throw new Error("Conversation changed before explicit enrollment.");
        },
      });
      const enrolled = { ...entry, conversationTopology: topology };
      await applySessionEntryLifecycleMutation({
        agentId,
        storePath: selected.path,
        env,
        activeSessionKey: sessionKey,
        skipMaintenance: true,
        source: composeSessionSourceAssertion([originalSource, retained]),
        commitGuard: assertConfigCurrent,
        upserts: [
          {
            sessionKey,
            conversationBranchAdmission: topology,
            buildEntry({ currentEntry }) {
              if (!sqliteSessionEntriesEqual(currentEntry, entry)) {
                throw new Error("Conversation changed before explicit enrollment.");
              }
              return enrolled;
            },
          },
        ],
      });
      return { entry: enrolled, enrolled: true };
    },
  );
}
