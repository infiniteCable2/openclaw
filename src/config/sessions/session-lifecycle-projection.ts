import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { sqliteSessionIdWriteScope } from "../../infra/sqlite-database-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { executeOpenClawAgentWorkerPublication } from "../../state/openclaw-agent-worker-store.js";
import type { SessionEntryLifecycleUpsert } from "./session-accessor.lifecycle-types.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import { buildProjectedLifecycleUpserts } from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  LifecycleRemovalProjectionInput,
  ReclamationDatabaseOptions,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import type { SessionEntryCommitContext } from "./session-accessor.types.js";
import { readSessionActorEntryFacts } from "./session-actor-replica.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import type {
  SessionLifecycleProjectionCommit,
  SessionLifecycleProjectionCommitted,
} from "./session-lifecycle-projection.types.js";
import type { SessionLifecyclePlanningOperations } from "./session-lifecycle-projection.worker.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import {
  acceptSessionSourceValidation,
  type PreparedSessionSourceAuthority,
  type SessionSourceValidation,
  type SessionSourceTransactionGrant,
} from "./session-source-authority.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

type SessionLifecyclePlanningOwner = {
  database: ReclamationDatabaseOptions;
  execution?: OpenClawAgentDatabaseExecution;
};

function runSessionLifecyclePlanningInWorker<Key extends keyof SessionLifecyclePlanningOperations>(
  params: SessionLifecyclePlanningOwner,
  type: Key,
  input: SessionLifecyclePlanningOperations[Key]["input"],
): Promise<SessionLifecyclePlanningOperations[Key]["output"]> {
  return withSessionEntryWorker(
    params.database,
    undefined,
    () => params.execution?.assertCurrent(),
    async (execution, source) => {
      const result = await execution.runExisting(source, async (worker) => ({
        value: await executeOpenClawAgentWorkerPublication<SessionLifecyclePlanningOperations, Key>(
          worker,
          {
            id: randomUUID(),
            moduleUrl: resolveRuntimeWorkerUrl(
              runtimeProcessEntrypoints.sessionLifecyclePlanningDomain,
            ).href,
            input: { agentId: params.database.agentId },
            command: { type, input },
          },
        ),
      }));
      if (!result) {
        throw new Error("Session database disappeared before lifecycle planning");
      }
      return result.value;
    },
    undefined,
    params.execution,
  );
}

/** Keep builders outside SQL while retaining the caller's physical FIFO and exact source. */
export async function projectSessionEntryLifecycleMutationInWorker(
  params: SessionLifecyclePlanningOwner & {
    execution: OpenClawAgentDatabaseExecution;
    input: LifecycleRemovalProjectionInput;
    upserts: readonly SessionEntryLifecycleUpsert[];
  },
) {
  const upsert = params.upserts[0];
  const sessionKey = upsert?.sessionKey.trim();
  const identity = params.execution.fileIdentity;
  const resident =
    identity &&
    sessionKey &&
    !params.input.allowCanonicalRepair &&
    params.input.removals.length === 0 &&
    params.upserts.length === 1 &&
    !upsert?.relatedSessionKeys?.some((key) => key !== sessionKey)
      ? readSessionActorEntryFacts({ database: identity, sessionKey })
      : undefined;
  const retained =
    resident?.snapshots === "full" &&
    resident.entry &&
    (upsert?.relatedSessionKeys === undefined || !resident.entry.parentSessionKey)
      ? resident
      : undefined;
  const prepared = await runSessionLifecyclePlanningInWorker(params, "prepare", {
    ...params.input,
    retainedEntry: retained && {
      writeToken: retained.writeToken,
      writeScopes: [
        ...collectSessionEntryLookupKeys(sessionKey!),
        ...retained.dependencySessionIds.map(sqliteSessionIdWriteScope),
      ],
    },
    upserts: params.upserts.map(({ sessionKey: key, relatedSessionKeys }) => ({
      sessionKey: key,
      ...(relatedSessionKeys !== undefined ? { relatedSessionKeys } : {}),
    })),
  });
  if (prepared.reuseEntry) {
    // The worker accepted this exact frozen preimage's receipt; builders still own their copies.
    prepared.store[sessionKey!] = retained!.entry!;
  }
  const upsertedEntries = await buildProjectedLifecycleUpserts(
    prepared.store,
    prepared.selected,
    params.upserts,
  );
  params.execution.assertCurrent();
  if (prepared.selected.projectedRemovals.length === 0) {
    return {
      deletePlans: [],
      removals: [],
      upsertedEntries,
      archiveRecovery: prepared.archiveRecovery,
    };
  }
  // The former finish round trip detached caller-owned metadata at this boundary.
  for (const preparedUpsert of upsertedEntries) {
    if (preparedUpsert.routeContext) {
      preparedUpsert.routeContext = structuredClone(preparedUpsert.routeContext);
    }
    if (preparedUpsert.resetBoundary) {
      preparedUpsert.resetBoundary = structuredClone(preparedUpsert.resetBoundary);
    }
  }
  return {
    ...(await runSessionLifecyclePlanningInWorker(params, "finish", {
      store: prepared.store,
      selected: prepared.selected,
      archiveDirectory: params.input.archiveDirectory,
    })),
    upsertedEntries,
  };
}

export function commitSessionLifecycleProjectionInWorker(params: {
  database: ReclamationDatabaseOptions;
  input: SessionLifecycleProjectionCommit;
  execution: OpenClawAgentDatabaseExecution;
  preparedSource?: PreparedSessionSourceAuthority;
  creationSource?: SessionSourceTransactionGrant;
  assertCurrent: () => void;
  assertPrepared: () => void;
  assertCandidate: (
    candidate: SessionLifecycleProjectionCommitted,
    operation: RetainedWorkerTransactionAdmission,
  ) => void;
  onLifecycleCommitted?: () => void;
  afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>;
}) {
  let creationFacts: SessionPendingInputAuthorityFacts | undefined;
  return runSessionEntryWorkerOperation<
    SessionLifecycleProjectionCommitted,
    SessionLifecycleProjectionCommitted["result"]
  >({
    database: params.database,
    agentId: params.input.agentId,
    assertCurrent: params.assertCurrent,
    assertPrepared: () => {
      params.assertPrepared();
      (params.preparedSource?.assertPreparedCurrent ?? params.preparedSource?.assertCurrent)?.();
    },
    onTransactionFacts(facts) {
      if (isRecord(facts) && facts.kind === "session-lifecycle-creation-validated") {
        if (!params.creationSource || !isRecord(facts.authority)) {
          throw new Error("Lifecycle creation omitted its transaction authority");
        }
        // SAFETY: The paired lifecycle worker supplies its locked pre-mutation facts.
        creationFacts = facts.authority as SessionPendingInputAuthorityFacts;
        params.creationSource.assertCurrent(creationFacts);
        return true;
      }
      if (!isRecord(facts) || facts.kind !== "session-lifecycle-source-validated") {
        return false;
      }
      if (!params.preparedSource || !isRecord(facts.sourceValidation)) {
        throw new Error("Lifecycle source validation has no prepared authority");
      }
      acceptSessionSourceValidation(
        params.preparedSource,
        // SAFETY: This lifecycle worker's marker carries readSessionSourceValidation's return value.
        facts.sourceValidation as SessionSourceValidation,
      );
      (params.preparedSource.assertPreparedCurrent ?? params.preparedSource.assertCurrent)();
      return true;
    },
    assertCandidate: (candidate, operation) => {
      if (params.creationSource) {
        if (!creationFacts) {
          throw new Error("Lifecycle creation omitted its transaction authority facts");
        }
        params.creationSource.assertCurrent(creationFacts);
      }
      if (params.preparedSource) {
        if (!candidate.sourceValidation) {
          throw new Error("Lifecycle commit omitted its prepared source validation");
        }
        acceptSessionSourceValidation(params.preparedSource, candidate.sourceValidation);
        (params.preparedSource.assertPreparedCurrent ?? params.preparedSource.assertCurrent)();
      }
      params.assertCandidate(candidate, operation);
    },
    retainedExecution: params.execution,
    candidateKind: "session-lifecycle-projection",
    run: (worker, commit) =>
      commit(() =>
        worker.execute({
          type: "session.lifecycle.project",
          input: {
            ...params.input,
            ...(params.creationSource
              ? {
                  creationSource: {
                    source: params.creationSource.source,
                    agentId: params.creationSource.agentId,
                    sessionKey: params.creationSource.sessionKey,
                  },
                }
              : {}),
            sources: params.preparedSource?.checks.map((check) => check.predicate),
          },
        }),
      ),
    onAcknowledged(candidate) {
      params.onLifecycleCommitted?.();
      for (const sessionId of candidate.projectionReconcileSessionIds) {
        startSessionTranscriptIndexReconcile({ ...params.database, preferredSessionId: sessionId });
      }
    },
    async onCommitted(candidate, published, identity, context) {
      for (const sessionKey of candidate.progressCardResetKeys) {
        emitSessionLifecycleEvent({
          agentId: params.input.agentId,
          sessionKey,
          reason: "progress-card-reset",
        });
      }
      if (published) {
        publishCommittedSessionIdentity(
          params.input.agentId,
          identity,
          published.previous,
          published.current,
          published.prepared,
        );
      }
      await params.afterCommitted?.(context);
      return candidate.result;
    },
  });
}
