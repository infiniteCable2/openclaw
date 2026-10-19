import fs from "node:fs";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  runSessionStartupMigration,
  type SessionStartupMigrationLogger,
} from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import {
  captureAgentDatabaseAdmission,
  readAgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { readAgentDeletionJournalStatusInWorker } from "../state/agent-deletion-journal.read.js";
import { AGENT_DATABASE_PREFLIGHT_CONCURRENCY } from "../state/openclaw-agent-db-contract.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  resolveOpenClawAgentSqlitePath,
  isSameOpenClawAgentDatabasePath,
} from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

type SessionMigrationDeps = Parameters<typeof runSessionStartupMigration>[0]["deps"] & {
  reconcileSessionTranscriptIndexes?: typeof import("../config/sessions/session-transcript-reconcile.js").reconcileSessionTranscriptIndexes;
};

export type PreparedStartupSessionDatabase = {
  database: OpenClawAgentDatabaseOptions & { path: string };
  assertCurrent: () => void;
};

/** Validate logical branch owners before startup can create roots or adopt history. */
async function assertConversationBranchStoresSupported(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  const branchAgentIds = agentIds.filter(
    (agentId) => resolveAgentConversationMode(params.cfg, agentId) === "branches",
  );
  if (branchAgentIds.length === 0) {
    return;
  }
  if (params.cfg.session?.scope === "global") {
    throw new Error("Conversation branches require per-agent session scope, not global scope");
  }
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
  };
  const env = params.env ?? process.env;
  const targets = [];
  // Include native and deferred agents: either can share a branch's physical store.
  for (const agentId of agentIds) {
    assertCurrent();
    const physical = await prepareSqliteTargetFromSessionStorePath(
      resolveSessionStorePathCore(params.cfg.session?.store, { agentId, env }),
      { agentId, env },
      params.signal,
    );
    assertCurrent();
    targets.push({ agentId, physical });
  }
  const isSameDatabasePath = createOpenClawAgentDatabasePathMatcher();
  for (const target of targets) {
    if (!branchAgentIds.includes(target.agentId)) {
      continue;
    }
    if (target.physical.agentId !== target.agentId) {
      throw new Error(
        `Cannot start conversation branches for agent "${target.agentId}": its session database belongs to another agent. Use a dedicated agent-owned session database (omit session.store to use the default per-agent layout), or set conversationMode to "native". Existing session data has not been moved or merged.`,
      );
    }
    const other = targets.find(
      (candidate) =>
        candidate.agentId !== target.agentId &&
        isSameDatabasePath(candidate.physical.path, target.physical.path),
    );
    if (other) {
      throw new Error(
        `Cannot start conversation branches for agent "${target.agentId}": agents "${target.agentId}" and "${other.agentId}" resolve to the same physical session database. Shared databases are not supported in branches mode. Use dedicated per-agent databases (omit session.store for the default layout), or set conversationMode to "native". Existing session data has not been moved or merged.`,
      );
    }
  }
  assertCurrent();
}

/** Normalize legacy outcomes before readiness; retain admitted stores for later transcript repair. */
export async function prepareGatewayStartupSessions(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentIds?: ReadonlySet<string>;
  getConfig?: () => OpenClawConfig;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<PreparedStartupSessionDatabase[]> {
  await assertConversationBranchStoresSupported(params);
  const databases: PreparedStartupSessionDatabase[] = [];
  const retainDatabase = (database: OpenClawAgentDatabaseOptions) => {
    params.assertCurrent?.();
    const identity = readDatabasePathIdentitySync(resolveOpenClawAgentSqlitePath(database));
    const state = captureOpenClawStateReadContext(resolveOpenClawStateSqlitePath(database.env));
    const assertAdmitted = captureAgentDatabaseAdmission(database.agentId, { env: database.env });
    databases.push({
      database: { ...database, path: identity.canonicalPath },
      assertCurrent: () => {
        state.admission.assertCurrent();
        assertAdmitted();
        assertExistingDatabaseIdentity(identity.canonicalPath, identity.key, identity.birthtime);
      },
    });
  };
  await runSessionStartupMigration({
    ...params,
    handoffDatabase: async (database) => {
      retainDatabase(database);
    },
  });
  for (const agentId of listAgentIds(params.cfg)) {
    if (
      (params.agentIds && !params.agentIds.has(agentId)) ||
      resolveAgentConversationMode(params.cfg, agentId) !== "branches" ||
      readAgentDatabaseAdmissionRefusal(agentId, { env: params.env })
    ) {
      continue;
    }
    const assertHostCurrent = () => {
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
    };
    assertHostCurrent();
    const env = params.env ?? process.env;
    const physical = await prepareSqliteTargetFromSessionStorePath(
      resolveSessionStorePathCore(params.cfg.session?.store, { agentId, env }),
      { agentId, env },
      params.signal,
    );
    assertHostCurrent();
    const admitted = databases.find(({ database }) =>
      isSameOpenClawAgentDatabasePath(database.path, physical.path),
    );
    if (!admitted && fs.existsSync(physical.path)) {
      throw new Error(`Conversation root store for ${agentId} was not admitted by startup`);
    }
    if (!admitted) {
      const deletion = await readAgentDeletionJournalStatusInWorker(physical.agentId ?? agentId, {
        env,
      });
      assertHostCurrent();
      if (deletion !== "absent") {
        throw new Error(
          `Conversation root for ${agentId} requires explicit restoration after agent deletion`,
        );
      }
    }
    const { ensureAgentConversationRoot } =
      await import("../config/sessions/session-conversation-root.js");
    const assertCurrent = () => {
      assertHostCurrent();
      admitted?.assertCurrent();
    };
    assertCurrent();
    await ensureAgentConversationRoot({
      cfg: params.cfg,
      agentId,
      env: params.env,
      admittedStorePath: physical.path,
      getConfig: params.getConfig,
      assertCurrent,
      signal: params.signal,
    });
    assertCurrent();
    // The native main keeps its identity and bytes. It is only registered as an
    // eligible source; later disclosure still needs the original person's grant.
    const { resolveAgentMainSessionKey } = await import("../config/sessions/main-session.js");
    const { prepareSessionConversationActivation } =
      await import("../config/sessions/session-conversation-activation.js");
    await prepareSessionConversationActivation({
      cfg: params.cfg,
      getConfig: params.getConfig,
      agentId,
      sessionKey: resolveAgentMainSessionKey({ cfg: params.cfg, agentId }),
      storePath: physical.path,
      env: params.env,
      assertCurrent,
      signal: params.signal,
    });
    assertCurrent();
    if (!admitted) {
      retainDatabase({ agentId: physical.agentId ?? agentId, env, path: physical.path });
    }
  }
  return databases;
}

/** Repair admitted startup targets without rediscovering stores or repeating admission. */
export async function runGatewaySessionStartupMaintenance(params: {
  databases: readonly PreparedStartupSessionDatabase[];
  assertCurrent?: () => void;
  signal?: AbortSignal;
  log: SessionStartupMigrationLogger;
  deps?: Pick<SessionMigrationDeps, "reconcileSessionTranscriptIndexes">;
  startupTrace?: GatewayStartupTrace;
}): Promise<void> {
  let reconcile = params.deps?.reconcileSessionTranscriptIndexes;
  let reconciledSessions = 0;
  const outcome = await runTasksWithConcurrency({
    limit: AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
    errorMode: "stop",
    tasks: params.databases.map(
      ({ database, assertCurrent: assertDatabaseCurrent }) =>
        async () => {
          const assertCurrent = () => {
            params.signal?.throwIfAborted();
            params.assertCurrent?.();
            assertDatabaseCurrent();
          };
          assertCurrent();
          const result = await measureStartup(
            params.startupTrace,
            "startup.maintenance.session-transcripts",
            async () => {
              reconcile ??= (await import("../config/sessions/session-transcript-reconcile.js"))
                .reconcileSessionTranscriptIndexes;
              assertCurrent();
              return reconcile({ ...database, assertCurrent, signal: params.signal });
            },
          );
          assertCurrent();
          reconciledSessions += result.reconciledSessions;
        },
    ),
  });
  if (outcome.hasError) {
    throw outcome.firstError;
  }
  if (reconciledSessions > 0) {
    params.log.info(`session: rebuilt ${reconciledSessions} transcript projection(s)`);
  }
}
