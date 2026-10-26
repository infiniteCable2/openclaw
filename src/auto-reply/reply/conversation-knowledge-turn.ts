import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";
import type { CustomMessage } from "../../agents/sessions/messages.js";
import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { ensureConversationKnowledgeSeed } from "../../config/sessions/conversation-knowledge-seed.js";
import {
  readConversationKnowledgeBranch,
  type ConversationKnowledgeBranch,
} from "../../config/sessions/conversation-knowledge-store.js";
import { withConversationPublicationContext } from "../../config/sessions/conversation-publication-context.js";
import {
  composeSessionSourceAssertion,
  createDynamicSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentTurnInternalResult, AgentTurnParams } from "./agent-runner-execution.types.js";
import type { prepareConversationKnowledgeRecipient } from "./conversation-knowledge-prefetch.js";
import { logConversationKnowledgeDiagnostic } from "./conversation-knowledge-status.js";
import {
  prepareReplyConversationKnowledge,
  type PreparedReplyConversationKnowledge,
} from "./conversation-knowledge.js";
import {
  captureReplyConversationPublication,
  recordReplyConversationPublication,
} from "./conversation-publication.js";
import { getReplyOperationSessionReader } from "./reply-run-registry.state.js";
import { resolveReplyRunTrigger } from "./reply-turn-kind.js";

/** One actual native turn retains its knowledge and publishes original committed dialogue. */
export function createReplyConversationKnowledgeTurn(params: {
  turn: Pick<AgentTurnParams, "followupRun" | "isHeartbeat" | "replyOperation">;
  originalSource: SessionSourceAssertion;
  getRuntimeConfig(): OpenClawConfig;
}) {
  const reader = getReplyOperationSessionReader(params.turn.replyOperation);
  const { followupRun } = params.turn;
  if (
    !reader ||
    resolveReplyRunTrigger(params.turn) !== "user" ||
    followupRun.currentInboundEventKind === "room_event"
  ) {
    return undefined;
  }
  const { sessionId, agentId } = followupRun.run;
  const getRuntimeConfig = () => params.getRuntimeConfig();
  let prepared: PreparedReplyConversationKnowledge | undefined;
  let execution: { admission: PreparedAgentRunAdmission; signal: AbortSignal } | undefined;
  let phase: "unprepared" | "prepared" | "released" = "unprepared";
  let enabled = false;
  let seedPending = false;
  let sourceMode: "native" | "branches" | undefined;
  let publicationBranch: ConversationKnowledgeBranch | undefined;
  let historyPrepared = false;
  let retainedFragments: RuntimeContextFragment[] = [];
  let recipient: ReturnType<typeof prepareConversationKnowledgeRecipient>;
  let preparedRun: RunEmbeddedAgentParams | undefined;
  let consumedRevision = -1;
  let morePreparedPackets = false;
  let sourceOffset = 0;
  const selected = createDynamicSessionSourceAssertion(
    () => prepared?.assertCurrent,
    () => {
      throw new Error("Conversation knowledge ownership changed during execution");
    },
  );
  const assertTurnSourceCurrent = composeSessionSourceAssertion(
    [params.originalSource],
    (check) => {
      if (phase === "released") {
        throw new Error("Conversation knowledge turn has been released");
      }
      if (sourceMode && resolveAgentConversationMode(getRuntimeConfig(), agentId) !== sourceMode) {
        throw new Error("Conversation mode changed during the admitted turn");
      }
      check();
    },
  );
  const assertCurrent = composeSessionSourceAssertion([assertTurnSourceCurrent, selected]);
  return {
    assertCurrent,
    get fragments(): readonly RuntimeContextFragment[] {
      assertCurrent();
      return prepared?.fragments ?? [];
    },
    async prepare(admission: PreparedAgentRunAdmission, signal: AbortSignal) {
      if (phase !== "unprepared") {
        throw new Error("Conversation knowledge turn already prepared");
      }
      phase = "prepared";
      execution = { admission, signal };
      assertCurrent();
      signal.throwIfAborted();
      sourceMode = resolveAgentConversationMode(followupRun.run.config, agentId);
      assertCurrent();
      // Previously enrolled native conversations retain only transition continuity.
      // An ordinary native session never starts sharing merely because a root exists.
      enabled =
        sourceMode === "branches" ||
        Boolean(
          await readConversationKnowledgeBranch({
            reader,
            sessionId,
            assertCurrent: assertTurnSourceCurrent,
          }),
        );
      if (enabled) {
        // This is the actual admitted native turn, not a read-only CLI/provider
        // startup snapshot. Establish the seed even without a verified audience
        // before this source may publish its first live completion reference.
        const seed = await ensureConversationKnowledgeSeed({
          reader,
          sessionId,
          assertCurrent: assertTurnSourceCurrent,
          signal,
        });
        seedPending = seed.status === "pending";
        if (seedPending) {
          logConversationKnowledgeDiagnostic({
            recipient: sessionId,
            reason: "initial-history-not-yet-verified",
          });
        }
        if (!seedPending) {
          publicationBranch = await readConversationKnowledgeBranch({
            reader,
            sessionId,
            assertCurrent: assertTurnSourceCurrent,
          });
          if (sourceMode === "branches" && publicationBranch && followupRun.conversationAudience) {
            try {
              const { prepareConversationKnowledgeRecipient } =
                await import("./conversation-knowledge-prefetch.js");
              recipient = prepareConversationKnowledgeRecipient({
                branch: publicationBranch,
                participant: followupRun.conversationParticipant,
                audience: followupRun.conversationAudience,
                env: reader.database.env,
                getRuntimeConfig,
              });
            } catch {
              // Optional warm-up has no authority to abort an admitted foreground input.
              logConversationKnowledgeDiagnostic({
                recipient: sessionId,
                reason: "preparation-deferred",
              });
            }
          }
        }
        assertCurrent();
      }
      assertCurrent();
      signal.throwIfAborted();
    },
    withPublication<T>(run: () => T): T {
      if (!execution) {
        throw new Error("Conversation publication execution was not prepared");
      }
      return withConversationPublicationContext(
        {
          source: { agentId, sessionId, sessionKey: reader.sessionKey },
          storePath: reader.database.path,
          recorder: followupRun.userTurnTranscriptRecorder,
          runId: execution.admission.operationalRunInstance.runId,
          capture: (role) =>
            captureReplyConversationPublication({
              followupRun,
              branch: publicationBranch,
              sourceMode,
              admission: execution?.admission,
              seedPending,
              observed: prepared?.observed,
              assertCurrent,
              role,
            }),
        },
        run,
      );
    },
    async prepareSnapshot(this: void): Promise<RuntimeContextFragment[]> {
      assertCurrent();
      if (!execution) {
        throw new Error("Conversation knowledge execution was not prepared");
      }
      if (!enabled) {
        return [];
      }
      execution.signal.throwIfAborted();
      if (seedPending) {
        return [];
      }
      // Only the actually selected read-only CLI candidate needs a preview.
      // Embedded runs retain their missing packets directly in prepareHistory.
      let next: PreparedReplyConversationKnowledge | undefined;
      try {
        next = await prepareReplyConversationKnowledge({
          reader,
          sessionId,
          assertCurrent: assertTurnSourceCurrent,
          originalParticipant: followupRun.conversationParticipant,
          destinationAudience: followupRun.conversationAudience,
          getRuntimeConfig,
          signal: execution.signal,
          ...(sourceMode === "branches" ? { sourceCache: recipient?.cache, readyOnly: true } : {}),
        });
      } catch (error) {
        if (sourceMode !== "branches") {
          throw error;
        }
        assertTurnSourceCurrent();
        execution.signal.throwIfAborted();
        logConversationKnowledgeDiagnostic({
          recipient: sessionId,
          reason: "preparation-deferred",
        });
      }
      prepared?.release();
      prepared = next;
      assertCurrent();
      execution.signal.throwIfAborted();
      return prepared?.fragments ?? [];
    },
    async prepareHistory(
      this: void,
      run: RunEmbeddedAgentParams,
    ): Promise<RuntimeContextFragment[]> {
      assertCurrent();
      if (!execution || !enabled) {
        return run.runtimeContextFragments ?? [];
      }
      if (historyPrepared) {
        // A CLI fallback's candidate-local preview must not replace or duplicate
        // the native history already admitted by this turn.
        return [
          ...(run.runtimeContextFragments ?? []).filter(
            (fragment) =>
              !prepared?.fragments.includes(fragment) && !retainedFragments.includes(fragment),
          ),
          ...retainedFragments,
        ];
      }
      if (
        run.agentId !== agentId ||
        run.sessionId !== sessionId ||
        run.sessionKey !== reader.sessionKey
      ) {
        throw new Error("Conversation knowledge native run changed its admitted recipient");
      }
      if (seedPending) {
        execution.signal.throwIfAborted();
        return run.runtimeContextFragments ?? [];
      }
      if (sourceMode === "branches" && followupRun.conversationAudience) {
        // Publication and source hydration run independently. The real model request
        // consumes only ready packets with its own native writer and budget below.
        preparedRun = run;
        return run.runtimeContextFragments ?? [];
      }
      const { signal } = execution;
      const preview = prepared?.fragments ?? [];
      const {
        createConversationKnowledgeMaintenance,
        resolveConversationKnowledgeContextLimits,
        withConversationKnowledgeWriter,
      } = await import("./conversation-knowledge-maintenance.js");
      const next = await withConversationKnowledgeWriter(
        { run, assertCurrent: assertTurnSourceCurrent },
        (writeTarget) =>
          prepareReplyConversationKnowledge({
            reader,
            sessionId,
            assertCurrent: assertTurnSourceCurrent,
            originalParticipant: followupRun.conversationParticipant,
            destinationAudience: followupRun.conversationAudience,
            getRuntimeConfig,
            signal,
            retainInHistory: {
              writeTarget,
              contextLimits: resolveConversationKnowledgeContextLimits(run),
              maintainContext: async (sources, packetIds, pendingText) =>
                createConversationKnowledgeMaintenance({
                  run: { ...followupRun.run, ...run },
                  assertCurrent: composeSessionSourceAssertion([assertCurrent, sources]),
                  signal,
                })(packetIds, pendingText),
            },
          }),
      );
      prepared?.release();
      prepared = next;
      historyPrepared = true;
      retainedFragments = prepared?.fragments ?? [];
      assertCurrent();
      signal.throwIfAborted();
      return [
        ...(run.runtimeContextFragments ?? []).filter((fragment) => !preview.includes(fragment)),
        ...(prepared?.fragments ?? []),
      ];
    },
    async refreshPrepared(
      this: void,
      input: {
        signal?: AbortSignal;
        canAdmit: (message: CustomMessage) => boolean;
      },
    ): Promise<CustomMessage[]> {
      assertCurrent();
      const run = preparedRun;
      if (!recipient || !run || !execution || phase === "released") {
        return [];
      }
      try {
        recipient.owner.assertCurrent();
      } catch {
        // An evicted cache may enroll again under still-live host evidence. Expired
        // audience evidence cannot be revived from stored participant metadata.
        if (publicationBranch) {
          try {
            const { prepareConversationKnowledgeRecipient } =
              await import("./conversation-knowledge-prefetch.js");
            recipient = prepareConversationKnowledgeRecipient({
              branch: publicationBranch,
              participant: followupRun.conversationParticipant,
              audience: followupRun.conversationAudience,
              env: reader.database.env,
              getRuntimeConfig,
            });
            consumedRevision = -1;
            sourceOffset = 0;
          } catch {
            // A closed connection/cache cannot cancel already accepted work.
          }
        }
        return [];
      }
      const revision = recipient.cache.revision;
      if (revision === consumedRevision && !morePreparedPackets) {
        return [];
      }
      const messages: CustomMessage[] = [];
      const { resolveConversationKnowledgeContextLimits, withConversationKnowledgeWriter } =
        await import("./conversation-knowledge-maintenance.js");
      const retainedSignal = execution.signal;
      const signal = input.signal
        ? AbortSignal.any([retainedSignal, input.signal])
        : retainedSignal;
      try {
        const next = await withConversationKnowledgeWriter(
          { run, assertCurrent: assertTurnSourceCurrent },
          (writeTarget) =>
            prepareReplyConversationKnowledge({
              reader,
              sessionId,
              assertCurrent: assertTurnSourceCurrent,
              originalParticipant: followupRun.conversationParticipant,
              destinationAudience: followupRun.conversationAudience,
              getRuntimeConfig,
              signal,
              retainedSignal,
              sourceCache: recipient!.cache,
              readyOnly: true,
              packetBudget: 8,
              sourceBudget: 8,
              sourceOffset,
              canAdmitPacket: input.canAdmit,
              onPacket: (message) => messages.push(message),
              retainInHistory: {
                writeTarget,
                contextLimits: resolveConversationKnowledgeContextLimits(run),
                // The upcoming native request has already supplied prospective token
                // admission. Background knowledge never invokes a model to compact.
                maintainContext: async () => ({ compacted: false, complete: true }),
              },
            }),
        );
        prepared?.release();
        prepared = next;
        consumedRevision = revision;
        morePreparedPackets = next?.pendingPackets === true;
        sourceOffset = next?.nextSourceOffset ?? 0;
      } catch {
        // Completed packet commits remain recipient history. Return their live
        // projections even if a later independent source failed; never replay tools.
        assertTurnSourceCurrent();
        signal.throwIfAborted();
        logConversationKnowledgeDiagnostic({
          recipient: sessionId,
          reason: "preparation-deferred",
        });
      }
      if (messages.length || recipient.cache.revision !== revision) {
        recipient.owner.request();
      }
      return messages;
    },
    async record(result: AgentTurnInternalResult) {
      await recordReplyConversationPublication({
        result,
        execution,
        enabled,
        seedPending,
        branch: publicationBranch,
        sessionId,
        getEnvironment: () => reader.database.env,
        assertCurrent,
      });
    },
    release() {
      if (phase === "released") {
        return;
      }
      phase = "released";
      prepared?.release();
    },
  };
}

export type ReplyConversationKnowledgeTurn = NonNullable<
  ReturnType<typeof createReplyConversationKnowledgeTurn>
>;
