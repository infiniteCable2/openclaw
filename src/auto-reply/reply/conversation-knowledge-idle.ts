import { setImmediate } from "node:timers/promises";
import { resolveGlobalLane, resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { createSessionMaintenanceOwner } from "../../agents/session-maintenance/coordinator.js";
import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { resolveIdleConversationKnowledgeProfile } from "./conversation-knowledge-idle-profile.js";
import {
  createConversationKnowledgeMaintenance,
  resolveConversationKnowledgeContextLimits,
} from "./conversation-knowledge-maintenance.js";
import type { ConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";

/** A scheduling quantum, not a limit on a recipient's historical catch-up. */
const IDLE_KNOWLEDGE_BATCH = 32;

export type IdleConversationKnowledgeResult = {
  /** Settled means the scan finished, not that unavailable sources became readable. */
  status: "settled" | "pending";
  admittedPackets: number;
  preempted?: boolean;
};

type IdleConversationKnowledgeParams = {
  branch: ConversationKnowledgeBranch;
  participant: SessionParticipantIdentity;
  audience: ConversationPrivateAudience;
  env: NodeJS.ProcessEnv;
  getRuntimeConfig(): OpenClawConfig;
  /** Data-only model/profile template; no execution or delivery callback is retained. */
  run?: RunEmbeddedAgentParams;
  signal?: AbortSignal;
  sourceCache?: ConversationKnowledgeSourceCache;
};

/** Release every acquired resource without replacing an earlier operation failure. */
async function withIdleResourceCleanup<T>(
  operation: () => T | Promise<T>,
  cleanup: () => void | Promise<void>,
  onCleanupFailure: () => void,
): Promise<T> {
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await operation() };
  } catch (error) {
    outcome = { error };
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    onCleanupFailure();
    if ("error" in outcome) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        "Idle maintenance operation and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Retain custody after native result delivery until all accepted cleanup settles. */
async function runWithIdleCleanup<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  onCleanupFailure: () => void,
): Promise<T> {
  const failures = new Set<unknown>();
  const work = new AsyncWorkScope(failures);
  const abort = () => work.beginClose(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  return withIdleResourceCleanup(
    () => work.run(operation),
    async () => {
      try {
        await AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => work.drain(),
        );
        if (failures.size === 1) {
          throw failures.values().next().value;
        }
        if (failures.size) {
          throw new AggregateError(failures, "Idle maintenance cleanup failed");
        }
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    onCleanupFailure,
  );
}

/** Update an idle recipient without inheriting a turn or replacing its writer. */
export function runIdleConversationKnowledge(
  params: IdleConversationKnowledgeParams,
): Promise<IdleConversationKnowledgeResult> {
  return runInDetachedAsyncContext(() => runIdleConversationKnowledgeDetached(params));
}

async function runIdleConversationKnowledgeDetached(
  params: IdleConversationKnowledgeParams,
): Promise<IdleConversationKnowledgeResult> {
  const branch = structuredClone(params.branch);
  const participant = structuredClone(params.participant);
  const audience = params.audience;
  const identity = conversationKnowledgeParticipantIdentity(participant);
  const generation = getAgentEventLifecycleGeneration();
  let admittedPackets = 0;
  let cleanupFailed = false;
  const markCleanupFailed = () => {
    cleanupFailed = true;
  };
  const interrupted = new AbortController();
  const owner = createSessionMaintenanceOwner({
    sessionKey: branch.sessionKey,
    preemptible: true,
    abortSignal: params.signal
      ? AbortSignal.any([params.signal, interrupted.signal])
      : interrupted.signal,
  });
  const assertAudience = () => {
    audience.assertCurrent();
    if (
      !identity ||
      identity !== conversationKnowledgeParticipantIdentity(audience.participant) ||
      audience.agentId !== branch.agentId ||
      audience.sessionKey !== branch.sessionKey ||
      resolveAgentConversationMode(params.getRuntimeConfig(), branch.agentId) !== "branches"
    ) {
      throw new Error("Idle conversation knowledge audience or mode changed");
    }
  };
  const check = () => {
    owner.assertCurrent();
    assertAudience();
  };
  return owner
    .track(
      owner.run(() =>
        runWithGatewayIndependentRootWorkAdmission(
          () =>
            enqueueCommandInLane(
              resolveSessionLane(branch.sessionKey),
              async () => {
                check();
                const held = await loadSessionEntryForAdmission(
                  { ...branch, env: params.env },
                  { signal: owner.signal, assertCurrent: check },
                );
                return withIdleResourceCleanup(
                  async () => {
                    check();
                    const reader =
                      "kind" in held.databaseClaim && held.databaseClaim.kind === "worker"
                        ? held.databaseClaim.reader
                        : undefined;
                    if (!reader || !held.entry) {
                      throw new Error("Idle conversation knowledge has no native recipient reader");
                    }
                    let currentEntry = held.entry;
                    const expectedOwner = {
                      lifecycleRevision: branch.lifecycleRevision,
                      activeWriterRunId: held.entry.activeWriterRunId,
                    };
                    const source = composeSessionSourceAssertion([
                      check,
                      () => held.databaseClaim.assertCurrent(),
                    ]);
                    const validate = () =>
                      reader.withRead({ sessionKeys: [branch.sessionKey] }, source, (facts) => {
                        const entry = facts.entries.find(
                          (row) => row.sessionKey === branch.sessionKey,
                        )?.entry;
                        const topology = entry?.conversationTopology;
                        // Closed reasons identify the failed fence without session or user data.
                        const reject = (
                          reason:
                            | "database-path"
                            | "session-incarnation"
                            | "lifecycle-revision"
                            | "writer"
                            | "incognito"
                            | "pending-delivery"
                            | "branch-role"
                            | "root-incarnation",
                        ): never => {
                          throw new Error(
                            `Idle conversation knowledge recipient ownership changed: ${reason}`,
                          );
                        };
                        if (facts.source.path !== branch.storePath) {
                          reject("database-path");
                        }
                        if (!entry || entry.sessionId !== branch.sessionId) {
                          return reject("session-incarnation");
                        }
                        if (entry.lifecycleRevision !== expectedOwner.lifecycleRevision) {
                          reject("lifecycle-revision");
                        }
                        if (entry.activeWriterRunId !== expectedOwner.activeWriterRunId) {
                          reject("writer");
                        }
                        if (entry.incognito) {
                          reject("incognito");
                        }
                        if (entry.pendingFinalDelivery) {
                          reject("pending-delivery");
                        }
                        if (topology?.role !== "branch") {
                          return reject("branch-role");
                        }
                        if (
                          topology.rootSessionKey !== branch.root.sessionKey ||
                          topology.rootSessionId !== branch.root.sessionId ||
                          topology.rootSessionLifecycleRevision !== branch.root.lifecycleRevision
                        ) {
                          reject("root-incarnation");
                        }
                        currentEntry = entry;
                      });
                    const admission = await beginSessionWorkAdmission({
                      scope: branch.storePath,
                      identities: [branch.sessionKey, branch.sessionId],
                      storeWriterIdentities: [branch.sessionKey],
                      signal: owner.signal,
                      assertAllowed: validate,
                      onInterrupt: (reason) => interrupted.abort(reason),
                    });
                    // Native compaction returns its result before its tracked cleanup
                    // tails. Keep those descendants inside this lane's custody too.
                    return withIdleResourceCleanup(
                      async () => {
                        source();
                        const writeTarget = {
                          agentId: branch.agentId,
                          sessionId: branch.sessionId,
                          sessionKey: branch.sessionKey,
                          storePath: branch.storePath,
                          expectedLifecycleRevision: expectedOwner.lifecycleRevision,
                          expectedWriterRunId: expectedOwner.activeWriterRunId,
                          // An absent writer is also an exact fence, not permission to borrow one.
                          expectedOwner,
                        };
                        const withWriter = async <T>(
                          target: BoundAgentRunSessionTarget,
                          operation: () => Promise<T>,
                        ): Promise<T> => {
                          source();
                          if (
                            target.agentId !== writeTarget.agentId ||
                            target.sessionId !== writeTarget.sessionId ||
                            target.sessionKey !== writeTarget.sessionKey ||
                            target.storePath !== writeTarget.storePath ||
                            target.expectedLifecycleRevision !==
                              writeTarget.expectedLifecycleRevision ||
                            target.expectedWriterRunId !== writeTarget.expectedWriterRunId
                          ) {
                            throw new Error("Idle conversation knowledge writer target changed");
                          }
                          await validate();
                          source();
                          return withOwnedSessionTranscriptWrites(
                            {
                              sessionTarget: writeTarget,
                              sessionReader: reader,
                              assertCommitAllowed: source,
                              withTranscriptWrite: async (write) => await write(),
                            },
                            async () => {
                              const result = await operation();
                              source();
                              return result;
                            },
                          );
                        };
                        let sourceCursor: string | undefined;
                        const unproductiveCursors = new Set<string | undefined>();
                        return await runWithIdleCleanup(
                          owner.signal,
                          () =>
                            admission.run(() =>
                              withWriter<IdleConversationKnowledgeResult>(writeTarget, async () => {
                                const run: RunEmbeddedAgentParams = {
                                  ...resolveIdleConversationKnowledgeProfile({
                                    branch,
                                    entry: currentEntry,
                                    cfg: params.getRuntimeConfig(),
                                    run: params.run,
                                  }),
                                  sessionTarget: writeTarget,
                                };
                                for (;;) {
                                  source();
                                  const before = admittedPackets;
                                  const prepared = await prepareReplyConversationKnowledge({
                                    reader,
                                    sessionId: branch.sessionId,
                                    assertCurrent: source,
                                    originalParticipant: participant,
                                    destinationAudience: audience,
                                    expectedAudienceIdentity: identity,
                                    getRuntimeConfig: () => params.getRuntimeConfig(),
                                    signal: owner.signal,
                                    sourceBudget: IDLE_KNOWLEDGE_BATCH,
                                    packetBudget: IDLE_KNOWLEDGE_BATCH,
                                    sourceCursor,
                                    sourceCache: params.sourceCache,
                                    onPacket: () => admittedPackets++,
                                    retainInHistory: {
                                      writeTarget,
                                      contextLimits: resolveConversationKnowledgeContextLimits(run),
                                      maintainContext: (sources, ids, text) =>
                                        enqueueCommandInLane(
                                          resolveGlobalLane(run.lane, run),
                                          async () => {
                                            source();
                                            // A summary-local scope cannot wait on its own
                                            // ingestion ancestors in the outer session scope.
                                            return await runWithIdleCleanup(
                                              owner.signal,
                                              () =>
                                                createConversationKnowledgeMaintenance({
                                                  run,
                                                  signal: owner.signal,
                                                  assertCurrent: composeSessionSourceAssertion([
                                                    source,
                                                    sources,
                                                  ]),
                                                  withWriter,
                                                })(ids, text),
                                              markCleanupFailed,
                                            );
                                          },
                                          {
                                            priority: "background",
                                            abortSignal: owner.signal,
                                            sessionTarget: writeTarget,
                                          },
                                        ),
                                    },
                                  });
                                  const result = await withIdleResourceCleanup<
                                    IdleConversationKnowledgeResult | undefined
                                  >(
                                    () => {
                                      source();
                                      if (!prepared?.pendingPackets) {
                                        return { status: "settled", admittedPackets };
                                      }
                                      const nextCursor = prepared.nextSourceCursor;
                                      if (admittedPackets === before) {
                                        unproductiveCursors.add(sourceCursor);
                                        if (unproductiveCursors.has(nextCursor)) {
                                          return { status: "pending", admittedPackets };
                                        }
                                      } else {
                                        unproductiveCursors.clear();
                                      }
                                      sourceCursor = nextCursor;
                                      return undefined;
                                    },
                                    () => prepared?.release(),
                                    markCleanupFailed,
                                  );
                                  if (result) {
                                    return result;
                                  }
                                  // Yield between quanta, but finish without needing another user turn.
                                  await setImmediate(undefined, { signal: owner.signal });
                                  source();
                                }
                              }),
                            ),
                          markCleanupFailed,
                        );
                      },
                      () => admission.release(),
                      markCleanupFailed,
                    );
                  },
                  () => held.databaseClaim.release(),
                  markCleanupFailed,
                );
              },
              {
                priority: "background",
                abortSignal: owner.signal,
                sessionTarget: branch,
              },
            ),
          "conversation-knowledge",
          owner.signal,
        ),
      ),
    )
    .catch((error: unknown) => {
      if (
        owner.signal.aborted &&
        !cleanupFailed &&
        !(error instanceof AggregateError) &&
        (error === owner.signal.reason || isAbortError(error)) &&
        !params.signal?.aborted &&
        !interrupted.signal.aborted &&
        !getGatewayRestartDrainSignal().aborted &&
        getAgentEventLifecycleGeneration() === generation
      ) {
        // Only foreground priority may enqueue a fresh waiting owner automatically.
        // Revoked audiences, external cancellation and retired runtimes never do.
        assertAudience();
        return { status: "pending" as const, admittedPackets, preempted: true };
      }
      throw error;
    });
}
