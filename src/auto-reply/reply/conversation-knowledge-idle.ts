import { isDeepStrictEqual } from "node:util";
import { resolveContextTokensForModelFromCache } from "../../agents/context-resolution.js";
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import type { PreparedConversationContextBudget } from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import { resolveEmbeddedSessionContextLimits } from "../../agents/embedded-agent-runner/run/session-context-limits.js";
import { MissingAgentHarnessError } from "../../agents/harness/errors.js";
import { resolveAgentHarnessSelectionDecision } from "../../agents/harness/selection-decision.js";
import { tryCreateIdleSessionMaintenanceOwner } from "../../agents/session-maintenance/coordinator.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import { MAX_TRANSCRIPT_REPORT_BATCH_SIZE } from "../../config/sessions/session-accessor.sqlite-transcript-reports.types.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
  type SessionSourcePredicate,
} from "../../config/sessions/session-source-authority.js";
import { readSessionTranscriptContextProjectionAsync } from "../../config/sessions/session-transcript-context-read.js";
import { readSessionTranscriptContextMessagesInWorker } from "../../config/sessions/session-transcript-read-worker-runtime.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError, isAbortError } from "../../infra/abort-signal.js";
import { enqueueCommandInLane, getQueueSize } from "../../process/command-queue.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
} from "../../sessions/session-lifecycle-admission.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";
import type { ReplyConversationKnowledgeParams } from "./conversation-knowledge.types.js";

type IdleKnowledgeParams = Pick<
  ReplyConversationKnowledgeParams,
  | "reader"
  | "sourceCache"
  | "originalParticipant"
  | "destinationAudience"
  | "expectedAudienceIdentity"
  | "getRuntimeConfig"
  | "assertCurrent"
  | "signal"
> & {
  branch: ConversationKnowledgeBranch;
  budget?: {
    value: PreparedConversationContextBudget;
    provider: string;
    model: string;
    config: OpenClawConfig;
  };
};

const IDLE_FIELDS: SessionSourcePredicate["fields"] = [
  "sessionId",
  "lifecycleRevision",
  "activeWriterRunId",
  "pendingFinalDelivery",
  "pendingTranscriptRepair",
  "archivedAt",
  "providerOverride",
  "modelOverride",
  "modelOverrideRouteResolution",
  "agentRuntimeOverride",
  "modelSelectionLocked",
  "agentHarnessId",
  "pluginOwnerId",
];

function isIdleEntry(entry: InternalSessionEntry | undefined, branch: ConversationKnowledgeBranch) {
  return (
    entry?.sessionId === branch.sessionId &&
    entry.lifecycleRevision === branch.lifecycleRevision &&
    entry.activeWriterRunId === undefined &&
    entry.pendingFinalDelivery === undefined &&
    !entry.pendingTranscriptRepair?.length &&
    entry.archivedAt === undefined
  );
}

/** Idle native maintenance admits prepared observations, never wakes a model or compacts a turn. */
export async function admitPreparedConversationKnowledgeWhileIdle(
  params: IdleKnowledgeParams,
): Promise<boolean> {
  const { branch, reader, sourceCache, budget } = params;
  const target = captureSessionTranscriptTargetBinding({ ...branch, env: reader.database.env });
  const lane = resolveSessionLane(branch.sessionKey);
  if (
    !budget ||
    params.getRuntimeConfig() !== budget.config ||
    !sourceCache ||
    (!sourceCache.preparedCheckpoint && !sourceCache.preparedPackets(1).length) ||
    getQueueSize(lane) > 0 ||
    isSessionWorkAdmissionActive(branch.storePath, [branch.sessionKey, branch.sessionId])
  ) {
    return false;
  }
  const queued = new AbortController();
  const owner = tryCreateIdleSessionMaintenanceOwner({
    sessionKey: branch.sessionKey,
    abortSignal: params.signal ? AbortSignal.any([params.signal, queued.signal]) : queued.signal,
  });
  if (!owner) {
    return false;
  }
  const assertCurrent = composeSessionSourceAssertion([params.assertCurrent, owner.assertCurrent]);
  const before = sourceCache.consumptionRevision;
  const preparedBefore = sourceCache.diagnosticCapacity().preparedPackets;
  const checkpointBefore = sourceCache.preparedCheckpoint;
  try {
    await owner.track(
      owner.run(() =>
        runWithGatewayIndependentRootWorkAdmission(
          () =>
            enqueueCommandInLane(
              lane,
              async () => {
                assertCurrent();
                let entry: InternalSessionEntry | undefined;
                let source: SessionSourceAssertion | undefined;
                const admission = await beginSessionWorkAdmission({
                  scope: branch.storePath,
                  identities: [branch.sessionKey, branch.sessionId],
                  signal: owner.signal,
                  assertAllowed: async () => {
                    await reader.withRead(
                      { sessionKeys: [branch.sessionKey], snapshotFields: [] },
                      assertCurrent,
                      (facts) => {
                        entry = facts.entries.find(
                          (row) => row.sessionKey === branch.sessionKey,
                        )?.entry;
                        if (!isIdleEntry(entry, branch)) {
                          throw createAbortError("Idle conversation recipient has an active owner");
                        }
                        const expected = structuredClone(entry);
                        source = composeSessionSourceAssertion([
                          assertCurrent,
                          Object.assign(() => assertCurrent(), {
                            prepareSessionSource: async () => ({
                              assertCurrent,
                              checks: [
                                {
                                  predicate: {
                                    source: facts.source,
                                    sessionKey: branch.sessionKey,
                                    fields: IDLE_FIELDS,
                                    expected,
                                  },
                                  refuse: (): never => {
                                    throw new Error(
                                      "Idle conversation recipient changed before commit",
                                    );
                                  },
                                },
                              ],
                            }),
                          }),
                        ]);
                      },
                    );
                  },
                });
                try {
                  await admission.run(async () => {
                    if (!entry || !source || !isIdleEntry(entry, branch)) {
                      return;
                    }
                    const cfg = params.getRuntimeConfig();
                    if (
                      cfg.plugins?.slots?.contextEngine &&
                      cfg.plugins.slots.contextEngine !== "legacy"
                    ) {
                      return;
                    }
                    const model = resolveSessionModelRef(cfg, entry, branch.agentId, {
                      allowPluginNormalization: false,
                    });
                    if (model.provider !== budget.provider || model.model !== budget.model) {
                      return;
                    }
                    const runtimePolicy = (
                      config: ReturnType<IdleKnowledgeParams["getRuntimeConfig"]>,
                    ) => {
                      try {
                        const selected = resolveAgentHarnessSelectionDecision({
                          config,
                          agentId: branch.agentId,
                          sessionKey: branch.sessionKey,
                          provider: model.provider,
                          modelId: model.model,
                          agentHarnessId: resolveSessionPinnedHarnessId(entry),
                          agentHarnessRuntimeOverride: entry?.agentRuntimeOverride,
                        });
                        return {
                          builtIn: selected.builtIn,
                          selectedHarnessId: selected.selectedHarnessId,
                          policy: selected.policy,
                        };
                      } catch (error) {
                        if (!(error instanceof MissingAgentHarnessError)) {
                          throw error;
                        }
                        return undefined;
                      }
                    };
                    const harness = runtimePolicy(cfg);
                    if (!harness?.builtIn) {
                      return;
                    }
                    const contextWindow = resolveContextTokensForModelFromCache({
                      cfg,
                      ...model,
                      allowUnscopedModelLookup: false,
                    });
                    if (!contextWindow || contextWindow !== budget.value.contextWindow) {
                      return;
                    }
                    const compactionPolicy = structuredClone(cfg.agents?.defaults?.compaction);
                    const contextEngine = cfg.plugins?.slots?.contextEngine;
                    const snapshot = await readSessionTranscriptContextProjectionAsync(
                      target,
                      async (selected) => {
                        const value = await readSessionTranscriptContextMessagesInWorker(
                          selected.target,
                          selected.admission,
                          owner.signal,
                          selected.physicalSource?.expectedIdentity,
                        );
                        return { value, version: value.version };
                      },
                      owner.signal,
                    );
                    source();
                    if (!snapshot.version) {
                      return;
                    }
                    const canAdmit = budget.value.capacityForMessages(snapshot.messages);
                    const check = composeSessionSourceAssertion([source], (assertSource) => {
                      assertSource();
                      const current = params.getRuntimeConfig();
                      if (
                        current !== budget.config ||
                        !isDeepStrictEqual(
                          model,
                          resolveSessionModelRef(current, entry, branch.agentId, {
                            allowPluginNormalization: false,
                          }),
                        ) ||
                        contextWindow !==
                          resolveContextTokensForModelFromCache({
                            cfg: current,
                            ...model,
                            allowUnscopedModelLookup: false,
                          }) ||
                        !isDeepStrictEqual(
                          compactionPolicy,
                          current.agents?.defaults?.compaction,
                        ) ||
                        !isDeepStrictEqual(harness, runtimePolicy(current)) ||
                        contextEngine !== current.plugins?.slots?.contextEngine
                      ) {
                        throw new Error("Idle conversation model budget changed");
                      }
                    });
                    check();
                    const prepared = await prepareReplyConversationKnowledge({
                      reader,
                      sourceCache,
                      originalParticipant: params.originalParticipant,
                      destinationAudience: params.destinationAudience,
                      expectedAudienceIdentity: params.expectedAudienceIdentity,
                      getRuntimeConfig: params.getRuntimeConfig,
                      sessionId: branch.sessionId,
                      signal: owner.signal,
                      assertCurrent: check,
                      readyOnly: true,
                      packetBudget: MAX_TRANSCRIPT_REPORT_BATCH_SIZE,
                      canAdmitPacket: canAdmit,
                      retainInHistory: {
                        writeTarget: {
                          ...target,
                          expectedLifecycleRevision: branch.lifecycleRevision,
                        },
                        contextLimits: resolveEmbeddedSessionContextLimits(contextWindow),
                        expectedTranscriptVersion: snapshot.version,
                        maintainContext: async () => ({
                          compacted: false,
                          complete: true,
                          canAdmitPending: true,
                        }),
                      },
                    });
                    prepared?.release();
                  });
                } finally {
                  admission.release();
                }
              },
              {
                abortSignal: owner.signal,
                priority: "background",
                sessionTarget: branch,
                // A non-maintenance producer may seize the lane after the idle probe.
                // Cancel our queued admission instead of waiting behind its conversation.
                onQueued: () =>
                  queued.abort(createAbortError("Idle conversation lane became busy")),
              },
            ),
          "conversation-knowledge-idle",
          owner.signal,
        ),
      ),
    );
  } catch (error) {
    if (!owner.signal.aborted && !isAbortError(error)) {
      throw error;
    }
  }
  // A failed native CAS can retire prepared packets without consuming history.
  // Let the existing owner reprepare that lost work once; ordinary metadata
  // publication and an unchanged over-budget queue must not create a retry loop.
  return (
    sourceCache.consumptionRevision !== before ||
    sourceCache.diagnosticCapacity().preparedPackets < preparedBefore ||
    (checkpointBefore !== undefined && sourceCache.preparedCheckpoint === undefined)
  );
}
