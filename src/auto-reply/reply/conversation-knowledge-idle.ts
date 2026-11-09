import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveContextTokensForModelFromCache } from "../../agents/context-resolution.js";
import type { PreparedConversationContextBudget } from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import { resolveEmbeddedSessionContextLimits } from "../../agents/embedded-agent-runner/run/session-context-limits.js";
import { MissingAgentHarnessError } from "../../agents/harness/errors.js";
import { resolveAgentHarnessSelectionDecision } from "../../agents/harness/selection-decision.js";
import { tryCreateIdleSessionMaintenanceOwner } from "../../agents/session-maintenance/coordinator.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import { MAX_TRANSCRIPT_REPORT_BATCH_SIZE } from "../../config/sessions/session-accessor.sqlite-transcript-reports.types.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
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
import { hasAgentRunContextExecutionOwner } from "../../infra/agent-run-registry.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  beginSessionEffect,
  isSessionControllerWorkActive,
  isCompetingSessionControllerWorkActive,
  hasSessionControllerQueuedWork,
} from "../../sessions/session-controller.lifecycle.js";
import {
  compactConversationKnowledgeWhileIdle,
  type IdleConversationKnowledgeCompactionState,
} from "./conversation-knowledge-idle-compaction.js";
import {
  resolveIdleConversationKnowledgeMaintenanceRequest,
  hasIdleConversationKnowledgeMaintenanceModelAuthority,
} from "./conversation-knowledge-idle-request.js";
import {
  logConversationKnowledgeIdleDeferral,
  type ConversationKnowledgeIdleDeferralReason,
} from "./conversation-knowledge-status.js";
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
  compaction?: IdleConversationKnowledgeCompactionState;
  budget?: {
    value: PreparedConversationContextBudget;
    provider: string;
    model: string;
    config: OpenClawConfig;
  };
  retainContextBudget?(
    capacity: ReturnType<PreparedConversationContextBudget["capacityForMessages"]>,
    model: { provider: string; model: string; config: OpenClawConfig },
  ): void;
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
  "authProfileOverride",
  "authProfileOverrideSource",
  "permissionMode",
  "sandboxMode",
  "sandbox",
  "sessionRoot",
  "visibility",
  "incognito",
  "publicShare",
  "conversationTopology",
  "participants",
  "participantCount",
  "chatType",
  "delivery",
  "repositoryWorkspaceId",
  "worktree",
  "spawnedBy",
  "spawnedWorkspaceDir",
  "spawnedCwd",
  "execNode",
  "execHost",
  "execCwd",
  "conversationRecipientEnrollment",
];

function isIdleEntry(entry: InternalSessionEntry | undefined, branch: ConversationKnowledgeBranch) {
  return (
    entry?.sessionId === branch.sessionId &&
    entry.lifecycleRevision === branch.lifecycleRevision &&
    entry.pendingFinalDelivery === undefined &&
    !entry.pendingTranscriptRepair?.length &&
    entry.archivedAt === undefined
  );
}

/** Idle maintenance admits observations; proven pressure may summarize existing history natively. */
export async function admitPreparedConversationKnowledgeWhileIdle(
  params: IdleKnowledgeParams,
): Promise<boolean> {
  const { branch, reader, sourceCache, budget } = params;
  const target = captureSessionTranscriptTargetBinding({ ...branch, env: reader.database.env });
  const defer = (reason: ConversationKnowledgeIdleDeferralReason) => {
    logConversationKnowledgeIdleDeferral({
      recipient: branch.sessionId,
      reason,
      preparedPackets: sourceCache?.diagnosticCapacity().preparedPackets ?? 0,
      checkpoint: sourceCache?.preparedCheckpoint !== undefined,
    });
    return false;
  };
  if (!budget && !params.compaction) {
    return defer("missing-budget");
  }
  if (budget && params.getRuntimeConfig() !== budget.config) {
    return defer("config-version");
  }
  if (!sourceCache || (!sourceCache.preparedCheckpoint && !sourceCache.preparedPackets(1).length)) {
    return defer("no-prepared");
  }
  if (
    isSessionControllerWorkActive(
      branch.storePath,
      [branch.sessionKey, branch.sessionId],
      branch.agentId,
    ) ||
    hasSessionControllerQueuedWork(
      branch.storePath,
      [branch.sessionKey, branch.sessionId],
      branch.agentId,
    )
  ) {
    return defer("busy");
  }
  // The persisted writer ID fences future commits; native completion need not
  // clear it. Runtime owners, rather than that durable ID, establish activity.
  params.assertCurrent();
  const executing = (entry?: InternalSessionEntry) =>
    isCompetingSessionControllerWorkActive(
      branch.storePath,
      [branch.sessionKey, branch.sessionId],
      branch.agentId,
    ) ||
    hasSessionControllerQueuedWork(
      branch.storePath,
      [branch.sessionKey, branch.sessionId],
      branch.agentId,
    ) ||
    (entry?.activeWriterRunId !== undefined &&
      hasAgentRunContextExecutionOwner(entry.activeWriterRunId));
  if (executing()) {
    return defer("busy");
  }
  const owner = tryCreateIdleSessionMaintenanceOwner({
    sessionKey: branch.sessionKey,
    abortSignal: params.signal,
  });
  if (!owner) {
    return defer("busy");
  }
  const assertCurrent = composeSessionSourceAssertion([params.assertCurrent, owner.assertCurrent]);
  const before = sourceCache.consumptionRevision;
  const preparedBefore = sourceCache.diagnosticCapacity().preparedPackets;
  const checkpointBefore = sourceCache.preparedCheckpoint;
  let reason: ConversationKnowledgeIdleDeferralReason = "no-progress";
  let capacityChecks = 0;
  let capacityRefusals = 0;
  const recordCapacity = (allowed: boolean) => {
    capacityChecks++;
    if (!allowed) {
      capacityRefusals++;
      reason = "capacity";
    } else if (reason === "missing-budget") {
      reason = "no-progress";
    }
    return allowed;
  };
  let compacted = false;
  try {
    await owner.track(
      owner.run({
        admit: (runAdmitted) =>
          runWithGatewayIndependentRootWorkAdmission(
            () =>
              withSessionTurn(
                { ...branch, abortSignal: owner.signal, projectSessionActive: false },
                async (operation, operationSignal) =>
                  runAdmitted(async () => {
                    operationSignal.throwIfAborted();
                    assertCurrent();
                    let entry: InternalSessionEntry | undefined;
                    let source: SessionSourceAssertion | undefined;
                    let recipientSource: CapturedSessionEntryReadSource | undefined;
                    let privateRecipient = false;
                    const assertIdle = () => {
                      operationSignal.throwIfAborted();
                      assertCurrent();
                      if (executing(entry)) {
                        throw createAbortError(
                          "Idle conversation yielded to a native execution owner",
                        );
                      }
                    };
                    await reader.withRead(
                      {
                        sessionKeys: [branch.sessionKey, branch.root.sessionKey],
                        snapshotFields: [],
                        includeMembers: true,
                      },
                      assertCurrent,
                      (facts) => {
                        entry = facts.entries.find(
                          (row) => row.sessionKey === branch.sessionKey,
                        )?.entry;
                        if (!isIdleEntry(entry, branch) || executing(entry)) {
                          // Ordinary contention retains prepared work for the
                          // next owner-settlement signal; it is not a lane error.
                          reason = "busy";
                          return;
                        }
                        const expected = structuredClone(entry);
                        recipientSource = facts.source;
                        const members = facts.members?.[branch.sessionKey]?.map(
                          (member) => member.identityId,
                        );
                        const root = facts.entries.find(
                          (row) => row.sessionKey === branch.root.sessionKey,
                        )?.entry;
                        const topology = entry?.conversationTopology;
                        privateRecipient = Boolean(
                          entry?.visibility === "draft" &&
                          !entry.incognito &&
                          entry.publicShare === undefined &&
                          topology?.role === "branch" &&
                          topology.rootSessionKey === branch.root.sessionKey &&
                          topology.rootSessionId === branch.root.sessionId &&
                          topology.rootSessionLifecycleRevision === branch.root.lifecycleRevision &&
                          root?.sessionId === branch.root.sessionId &&
                          root.lifecycleRevision === branch.root.lifecycleRevision &&
                          members &&
                          members.every(
                            (member) =>
                              params.originalParticipant?.type === "profile" &&
                              member === params.originalParticipant.id,
                          ),
                        );
                        source = composeSessionSourceAssertion([
                          assertIdle,
                          Object.assign(() => assertIdle(), {
                            prepareSessionSource: async () => ({
                              assertCurrent: assertIdle,
                              checks: [
                                {
                                  predicate: {
                                    source: facts.source,
                                    sessionKey: branch.sessionKey,
                                    fields: IDLE_FIELDS,
                                    expected,
                                    ...(members ? { members } : {}),
                                  },
                                  refuse: (): never => {
                                    throw new Error(
                                      "Idle conversation recipient changed before commit",
                                    );
                                  },
                                },
                                ...(privateRecipient
                                  ? [
                                      {
                                        predicate: {
                                          source: facts.source,
                                          sessionKey: branch.root.sessionKey,
                                          fields: [
                                            "sessionId",
                                            "lifecycleRevision",
                                            "conversationTopology",
                                            "archivedAt",
                                          ] satisfies SessionSourcePredicate["fields"],
                                          expected: structuredClone(root),
                                        },
                                        refuse: (): never => {
                                          throw new Error(
                                            "Idle maintenance root changed before commit",
                                          );
                                        },
                                      },
                                    ]
                                  : []),
                              ],
                            }),
                          }),
                        ]);
                      },
                    );
                    if (!source || !entry) {
                      return;
                    }
                    const admission = await beginSessionEffect({
                      agentId: branch.agentId,
                      operation,
                      scope: branch.storePath,
                      identities: [branch.sessionKey, branch.sessionId],
                      signal: operationSignal,
                      assertAllowed: assertIdle,
                    });
                    try {
                      await admission.run(async () => {
                        if (!entry || !source || !isIdleEntry(entry, branch)) {
                          reason = "busy";
                          return;
                        }
                        const cfg = params.getRuntimeConfig();
                        if (
                          cfg.plugins?.slots?.contextEngine &&
                          cfg.plugins.slots.contextEngine !== "legacy"
                        ) {
                          reason = "context-engine";
                          return;
                        }
                        const model = resolveSessionModelRef(cfg, entry, branch.agentId, {
                          allowPluginNormalization: false,
                        });
                        if (
                          budget &&
                          (model.provider !== budget.provider || model.model !== budget.model)
                        ) {
                          reason = "model";
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
                          reason = "harness";
                          return;
                        }
                        const contextWindow = resolveContextTokensForModelFromCache({
                          cfg,
                          ...model,
                          allowUnscopedModelLookup: false,
                        });
                        if (
                          !contextWindow ||
                          (budget && contextWindow !== budget.value.contextWindow)
                        ) {
                          reason = "context-window";
                          return;
                        }
                        const compactionPolicy = structuredClone(cfg.agents?.defaults?.compaction);
                        const contextEngine = cfg.plugins?.slots?.contextEngine;
                        const readContext = () =>
                          readSessionTranscriptContextProjectionAsync(
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
                        const snapshot = await readContext();
                        source();
                        if (!snapshot.version) {
                          reason = "context-unavailable";
                          return;
                        }
                        const capacity = budget?.value.capacityForMessages(snapshot.messages);
                        let refusedPacket: Parameters<NonNullable<typeof capacity>>[0] | undefined;
                        let existingCarriers: Set<string> | undefined;
                        const canAdmit: NonNullable<typeof capacity> = (message) => {
                          const id = asOptionalRecord(message.details)?.packetId;
                          if (typeof id === "string") {
                            existingCarriers ??= new Set(
                              snapshot.messages.flatMap((candidate) => {
                                if (candidate.role !== "custom") {
                                  return [];
                                }
                                const packetId = asOptionalRecord(candidate.details)?.packetId;
                                return typeof packetId === "string"
                                  ? [`${candidate.customType}\0${packetId}`]
                                  : [];
                              }),
                            );
                            if (existingCarriers.has(`${message.customType}\0${id}`)) {
                              return true;
                            }
                          }
                          if (!capacity) {
                            reason = "missing-budget";
                            refusedPacket ??= message;
                            return false;
                          }
                          const allowed = recordCapacity(capacity(message));
                          if (!allowed) {
                            refusedPacket ??= message;
                          }
                          return allowed;
                        };
                        const check = composeSessionSourceAssertion([source], (assertSource) => {
                          assertSource();
                          const current = params.getRuntimeConfig();
                          if (
                            current !== (budget?.config ?? cfg) ||
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
                        const admit = async (
                          canAdmitPacket: typeof canAdmit,
                          version: typeof snapshot.version,
                        ) => {
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
                            canAdmitPacket,
                            retainInHistory: {
                              writeTarget: {
                                ...target,
                                expectedLifecycleRevision: branch.lifecycleRevision,
                              },
                              contextLimits: resolveEmbeddedSessionContextLimits({
                                contextTokenBudget: contextWindow,
                              }),
                              expectedTranscriptVersion: version,
                              maintainContext: async () => ({
                                compacted: false,
                                complete: true,
                                canAdmitPending: true,
                              }),
                            },
                          });
                          prepared?.release();
                        };
                        await admit(canAdmit, snapshot.version);
                        const placement = budget?.value.compactionPlacement;
                        if (
                          refusedPacket &&
                          recipientSource &&
                          params.compaction &&
                          privateRecipient &&
                          hasIdleConversationKnowledgeMaintenanceModelAuthority({
                            config: cfg,
                            entry,
                            branch,
                          }) &&
                          (!placement ||
                            !entry.authProfileOverride ||
                            entry.authProfileOverride === placement.authProfileId) &&
                          (!placement ||
                            !entry.permissionMode ||
                            entry.permissionMode === placement.permissionMode) &&
                          (!placement ||
                            !entry.sessionRoot ||
                            entry.sessionRoot === placement.sessionRoot) &&
                          sourceCache.consumptionRevision === before
                        ) {
                          compacted = await compactConversationKnowledgeWhileIdle({
                            budget: budget?.value,
                            // A native probe retains capacity, not foreground placement.
                            request: placement
                              ? undefined
                              : resolveIdleConversationKnowledgeMaintenanceRequest({
                                  config: cfg,
                                  entry,
                                  branch,
                                }),
                            config: cfg,
                            target: {
                              ...target,
                              expectedLifecycleRevision: branch.lifecycleRevision,
                            },
                            version: snapshot.version,
                            source: recipientSource,
                            consumptionRevision: sourceCache.consumptionRevision,
                            packet: refusedPacket,
                            state: params.compaction,
                            assertCurrent: check,
                            signal: owner.signal,
                            onNativeDecision: recordCapacity,
                            onReady: async (nativeBudget, version) => {
                              const current = await readContext();
                              check();
                              if (!isDeepStrictEqual(current.version, version)) {
                                return false;
                              }
                              // Source custody can change during compaction. Keep the native
                              // footprint for the existing owner's reprepare, without replacing
                              // a foreground budget that also accounts for its tools.
                              if (!budget) {
                                params.retainContextBudget?.(nativeBudget.capacityForMessages([]), {
                                  ...model,
                                  config: cfg,
                                });
                              }
                              const consumptionBefore = sourceCache.consumptionRevision;
                              const nativeCapacity = nativeBudget.capacityForMessages(
                                current.messages,
                              );
                              const foregroundCapacity = budget?.value.capacityForMessages(
                                current.messages,
                              );
                              await admit(
                                (message) =>
                                  recordCapacity(
                                    nativeCapacity(message) &&
                                      (foregroundCapacity?.(message) ?? true),
                                  ),
                                version,
                              );
                              return consumptionBefore !== sourceCache.consumptionRevision;
                            },
                            readContext,
                          });
                        }
                      });
                    } finally {
                      admission.release();
                    }
                  }),
              ),
            "conversation-knowledge-idle",
            owner.signal,
          ),
      }),
    );
  } catch (error) {
    if (!owner.signal.aborted && !isAbortError(error)) {
      throw error;
    }
    reason = "busy";
  }
  // A failed native CAS can retire prepared packets without consuming history.
  // Let the existing owner reprepare that lost work once; ordinary metadata
  // publication and an unchanged over-budget queue must not create a retry loop.
  const progressed =
    sourceCache.consumptionRevision !== before ||
    sourceCache.diagnosticCapacity().preparedPackets < preparedBefore ||
    (checkpointBefore !== undefined && sourceCache.preparedCheckpoint === undefined);
  if (!progressed || capacityRefusals > 0) {
    logConversationKnowledgeIdleDeferral({
      recipient: branch.sessionId,
      reason,
      preparedPackets: sourceCache.diagnosticCapacity().preparedPackets,
      checkpoint: sourceCache.preparedCheckpoint !== undefined,
      consumptionChanges: sourceCache.consumptionRevision - before,
      capacityChecks,
      capacityRefusals,
    });
  }
  return progressed || compacted;
}
