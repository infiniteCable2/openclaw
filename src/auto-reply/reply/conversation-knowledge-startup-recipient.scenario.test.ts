import "../../test-utils/prepare-compiled-subprocesses.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { createConversationContextCapacity } from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { beginForegroundSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
} from "../../config/sessions/conversation-knowledge-packets.js";
import { recordConversationKnowledgeTurn } from "../../config/sessions/conversation-knowledge-store.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as contextReads from "../../config/sessions/session-transcript-context-read.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { openConversationKnowledgeRoot } from "./conversation-knowledge-open.js";
import * as recipientPreparation from "./conversation-knowledge-prefetch.js";
import { createReplyConversationKnowledgeTurn } from "./conversation-knowledge-turn.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";
import { lifecycleAdmissionByOperation } from "./reply-run-registry.state.js";
import { createMockFollowupRun, createMockReplyOperation } from "./test-helpers.js";

const model = vi.hoisted(() => ({ summarize: vi.fn(), compact: vi.fn() }));
// mock-isolation: Supply only model planning metadata; native startup, authority,
// worker reads, prepared packets and recipient COMMIT remain real.
vi.mock("./conversation-knowledge-checkpoint-model.js", () => ({
  acquireConversationKnowledgeCheckpointModel: async () => ({
    planning: {
      budget: { contextTokenBudget: 1_000_000, prompt: "" },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 16_384 },
    },
    summarize: model.summarize,
    async [Symbol.asyncDispose]() {},
  }),
}));
// mock-isolation: Receiving prepared history must not invoke model compaction.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: model.compact,
}));

it("prepares an existing recipient through cold root startup before its first native boundary", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createConversationKnowledgeScenario(state);
    let startup: Awaited<ReturnType<typeof openConversationKnowledgeRoot>>;
    let recipient: ReturnType<typeof recipientPreparation.prepareConversationKnowledgeRecipient>;
    let releaseTurn = () => {};
    let releaseForeground = () => {};
    let resumePreparation = () => {};
    const enroll = vi.spyOn(recipientPreparation, "prepareConversationKnowledgeRecipient");
    onTestFinished(() => enroll.mockRestore());
    try {
      const source = await fixture.branch("startup-originals");
      const sourceOwner = await fixture.claim(source);
      for (let index = 0; index < 2; index++) {
        const terminal = await fixture.append(
          source,
          `startup-${index}`,
          "stop",
          `STARTUP_FACT_${index}`,
        );
        expect(
          await recordConversationKnowledgeTurn({
            ...sourceOwner,
            ...terminal,
            privateAudience: { participant: person, admission: terminal.admission! },
          }),
        ).toBe(true);
      }
      const expected = (await fixture.receipts()).map(conversationKnowledgeContributionId);
      expect(expected).toHaveLength(2);
      const foreground = new AsyncLocalStorage<boolean>();
      let sourceTextReads = 0;
      let preparedSourceReads = 0;
      const singleRead = contextReads.readSessionTranscriptModelContextAsync;
      const batchRead = contextReads.readSessionTranscriptModelContextsAsync;
      const observeRead = (sessionId: string | undefined) => {
        if (sessionId === source.sessionId) {
          if (foreground.getStore()) {
            sourceTextReads++;
          } else {
            preparedSourceReads++;
          }
        }
      };
      const single = vi
        .spyOn(contextReads, "readSessionTranscriptModelContextAsync")
        .mockImplementation((...args) => {
          observeRead(args[0].sessionId);
          return singleRead(...args);
        });
      const batch = vi
        .spyOn(contextReads, "readSessionTranscriptModelContextsAsync")
        .mockImplementation((...args) => {
          observeRead(args[0].sessionId);
          return batchRead(...args);
        });
      onTestFinished(() => {
        single.mockRestore();
        batch.mockRestore();
        foreground.disable();
      });
      const target = await fixture.branch("startup-existing-recipient");
      await replaceTranscriptEvents(target, [
        { type: "session", id: target.sessionId, version: CURRENT_SESSION_VERSION },
      ]);
      const owner = await fixture.claim(target);
      const audience: ConversationPrivateAudience = {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        channelId: "test",
        accountId: "default",
        nativeChannelId: "synthetic-startup-recipient",
        participant: person,
        assertCurrent: owner.assertCurrent,
      };
      const before = await loadTranscriptEvents(target);
      const rootBefore = await loadTranscriptEvents(fixture.root);
      const entryBefore = loadSessionEntry(target);
      const rootReady = createDeferredCore();
      startup = await openConversationKnowledgeRoot({
        target,
        participant: person,
        audience,
        env: state.env,
        signal,
        getRuntimeConfig: () => fixture.cfg,
        onReady: () => rootReady.resolve(),
      });
      // Observe the owner actually enrolled by the startup entry point. Calling
      // prepareConversationKnowledgeRecipient here would hide the original gap.
      const enrollment = enroll.mock.results[0];
      if (enrollment?.type === "return") {
        recipient = enrollment.value;
      }
      expect(startup).toBeDefined();
      expect(enroll).toHaveBeenCalledOnce();
      expect(enroll.mock.calls[0]?.[0].branch.sessionId).toBe(target.sessionId);
      if (enrollment?.type !== "return" || !enrollment.value) {
        throw new Error("Cold startup did not enroll its existing recipient");
      }
      recipient = enrollment.value;
      await withinTest(rootReady.promise, signal);
      await withinTest(recipient.owner.wait(), signal);
      expect(preparedSourceReads).toBeGreaterThan(0);
      expect(recipient.cache.preparedPackets(3).map((packet) => packet.contributionId)).toEqual(
        expected,
      );
      for (const [index, id] of expected.entries()) {
        expect(recipient.cache.peek(id, 0)?.part.text).toContain(`STARTUP_FACT_${index}`);
      }
      // No prior request issued a token footprint, and startup must neither seed
      // an old conversation nor write packets into its canonical transcript.
      expect(await loadTranscriptEvents(target)).toEqual(before);
      expect(await loadTranscriptEvents(fixture.root)).toEqual(rootBefore);
      expect(loadSessionEntry(target)).toEqual(entryBefore);
      expect(model.summarize).not.toHaveBeenCalled();
      expect(model.compact).not.toHaveBeenCalled();

      releaseForeground = await beginForegroundSessionMaintenance(target.sessionKey);
      resumePreparation = recipient.owner.pausePreparation();
      await withinTest(recipient.owner.wait(), signal);
      const nativeTarget = await resolveAgentRunSessionTarget({
        ...target,
        sessionTarget: target,
        config: fixture.cfg,
        missingSessionKey: "resolve-existing",
      });
      const runId = "startup-first-native-request";
      const writer = {
        ...nativeTarget,
        expectedLifecycleRevision: target.lifecycleRevision,
        expectedWriterRunId: runId,
      };
      await upsertSessionEntryCore(target, {
        ...loadSessionEntry(target)!,
        activeWriterRunId: runId,
      });
      const { replyOperation } = createMockReplyOperation({
        key: target.sessionKey,
        sessionId: target.sessionId,
      });
      lifecycleAdmissionByOperation.set(replyOperation, { reader: owner.reader });
      const admission = prepareAgentRunAdmission({
        cfg: fixture.cfg,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        assertSourceCurrent: owner.assertCurrent,
        facts: {
          runId,
          agentId: target.agentId,
          ingress: { kind: "channel", boundary: "startup-native-test", state: "present" },
        },
      });
      releaseTurn = () => {
        admission.close();
        lifecycleAdmissionByOperation.delete(replyOperation);
      };
      const followupRun = createMockFollowupRun({
        conversationParticipant: person,
        conversationAudience: audience,
        run: { ...nativeTarget, config: fixture.cfg, provider: "synthetic", model: "cold-model" },
      });
      const knowledge = createReplyConversationKnowledgeTurn({
        turn: { isHeartbeat: false, followupRun, replyOperation },
        originalSource: owner.assertCurrent,
        getRuntimeConfig: () => fixture.cfg,
      });
      if (!knowledge) {
        throw new Error("Expected real native knowledge turn");
      }
      const closeAdmission = releaseTurn;
      releaseTurn = () => {
        try {
          knowledge.release();
        } finally {
          closeAdmission();
        }
      };
      await foreground.run(true, async () => {
        await knowledge.prepare(admission, signal);
        await withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
          knowledge.prepareHistory({
            ...followupRun.run,
            runId,
            prompt: "Recall the prepared facts.",
            sessionTarget: writer,
            contextTokenBudget: 1_000_000,
          }),
        );
        const refresh = () =>
          withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
            knowledge.refreshPrepared({
              signal,
              canAdmit: createConversationContextCapacity({
                messages: [],
                contextWindow: 1_000_000,
                reserveTokens: 16_384,
              }),
            }),
          );
        const messages = await refresh();
        expect(
          messages.map((message) => asOptionalRecord(message.details)?.contributionId),
        ).toEqual(expected);
        for (let index = 0; index < 2; index++) {
          expect(JSON.stringify(messages).split(`STARTUP_FACT_${index}`)).toHaveLength(2);
        }
        expect(await refresh()).toEqual([]);
      });
      expect(sourceTextReads).toBe(0);
      const packets = (await loadTranscriptEvents(target)).flatMap((event) => {
        const row = asOptionalRecord(event);
        return row?.customType === CONVERSATION_KNOWLEDGE_CONTEXT
          ? [asOptionalRecord(row.details)?.contributionId]
          : [];
      });
      expect(packets).toEqual(expected);
      expect(model.summarize).not.toHaveBeenCalled();
      expect(model.compact).not.toHaveBeenCalled();
    } finally {
      try {
        releaseTurn();
      } finally {
        resumePreparation();
        releaseForeground();
        try {
          await recipient?.owner.close();
        } finally {
          try {
            await startup?.close();
          } finally {
            await fixture.close();
          }
        }
      }
    }
  });
});
