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
};

/** Retain custody after native result delivery until all accepted cleanup settles. */
async function runWithIdleCleanup<T>(
  signal: AbortSignal,
  failures: Set<unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const work = new AsyncWorkScope(failures);
  const abort = () => work.beginClose(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  try {
    return await work.run(operation);
  } finally {
    try {
      await AsyncWorkScope.runWhenAllIdle(
        () => [work],
        () => work.drain(),
      );
      if (failures.size) {
        throw new AggregateError(failures, "Idle maintenance cleanup failed");
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
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
                try {
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
                      if (
                        facts.source.path !== branch.storePath ||
                        entry?.sessionId !== branch.sessionId ||
                        entry.lifecycleRevision !== expectedOwner.lifecycleRevision ||
                        entry.activeWriterRunId !== expectedOwner.activeWriterRunId ||
                        entry.incognito ||
                        entry.pendingFinalDelivery ||
                        topology?.role !== "branch" ||
                        topology.rootSessionKey !== branch.root.sessionKey ||
                        topology.rootSessionId !== branch.root.sessionId ||
                        topology.rootSessionLifecycleRevision !== branch.root.lifecycleRevision
                      ) {
                        throw new Error("Idle conversation knowledge recipient ownership changed");
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
                  const cleanupFailures = new Set<unknown>();
                  try {
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
                    let sourceOffset = 0;
                    const unproductiveOffsets = new Set<number>();
                    return await runWithIdleCleanup(owner.signal, cleanupFailures, () =>
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
                              getRuntimeConfig: params.getRuntimeConfig,
                              signal: owner.signal,
                              sourceBudget: IDLE_KNOWLEDGE_BATCH,
                              packetBudget: IDLE_KNOWLEDGE_BATCH,
                              sourceOffset,
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
                                        cleanupFailures,
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
                            try {
                              source();
                              if (!prepared?.pendingPackets) {
                                return { status: "settled", admittedPackets };
                              }
                              const nextOffset = prepared.nextSourceOffset ?? 0;
                              if (admittedPackets === before) {
                                unproductiveOffsets.add(sourceOffset);
                                if (unproductiveOffsets.has(nextOffset)) {
                                  return { status: "pending", admittedPackets };
                                }
                              } else {
                                unproductiveOffsets.clear();
                              }
                              sourceOffset = nextOffset;
                            } finally {
                              try {
                                prepared?.release();
                              } catch (error) {
                                cleanupFailed = true;
                                throw error;
                              }
                            }
                            // Yield between quanta, but finish without needing another user turn.
                            await setImmediate(undefined, { signal: owner.signal });
                            source();
                          }
                        }),
                      ),
                    );
                  } finally {
                    try {
                      if (cleanupFailures.size) {
                        cleanupFailed = true;
                        throw new AggregateError(
                          cleanupFailures,
                          "Idle maintenance cleanup failed",
                        );
                      }
                    } finally {
                      try {
                        admission.release();
                      } catch (error) {
                        cleanupFailed = true;
                        throw error;
                      }
                    }
                  }
                } finally {
                  try {
                    await held.databaseClaim.release();
                  } catch (error) {
                    cleanupFailed = true;
                    throw error;
                  }
                }
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
