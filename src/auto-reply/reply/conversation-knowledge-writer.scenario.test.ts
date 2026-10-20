import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { CONVERSATION_KNOWLEDGE_CONTEXT } from "../../config/sessions/conversation-knowledge-packets.js";
import { recordConversationKnowledgeTurn } from "../../config/sessions/conversation-knowledge-store.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createReplyConversationKnowledgeTurn } from "./conversation-knowledge.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";
import { lifecycleAdmissionByOperation } from "./reply-run-registry.state.js";
import { createMockFollowupRun, createMockReplyOperation } from "./test-helpers.js";

const budget = vi.hoisted(() => ({
  compact: vi.fn(async () => ({ ok: true, compacted: false, reason: "within budget" })),
}));
// mock-isolation: No provider/model compaction; native target, cohort, writer and packet I/O remain real.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: budget.compact,
}));

describe("native turn packet writer custody", () => {
  it("retains physical-source knowledge through the admitted logical native writer exactly once", async ({
    signal,
  }) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "knowledge-logical-writer" },
      async (state) => {
        const fixture = await createConversationKnowledgeScenario(state);
        try {
          const donor = await fixture.branch("donor");
          const donorOwner = await fixture.claim(donor);
          const terminal = await fixture.append(
            donor,
            "known-fact",
            "stop",
            "The color is yellow.",
          );
          expect(await recordConversationKnowledgeTurn({ ...donorOwner, ...terminal })).toBe(true);
          const recipient = await fixture.branch("recipient");
          const target = await resolveAgentRunSessionTarget({
            agentId: recipient.agentId,
            sessionId: recipient.sessionId,
            sessionKey: recipient.sessionKey,
            config: fixture.cfg,
            missingSessionKey: "resolve-existing",
          });
          expect(target.storePath).not.toBe(recipient.storePath);
          const runId = "native-recipient-run";
          const writer = {
            ...target,
            expectedLifecycleRevision: recipient.lifecycleRevision,
            expectedWriterRunId: runId,
          };
          await upsertSessionEntryCore(recipient, {
            ...loadSessionEntry(recipient)!,
            activeWriterRunId: runId,
          });
          // Admit the logical selector, as the real native lane does. The reader
          // still supplies physical SQLite provenance for source authorization.
          const owner = await fixture.claim({ ...recipient, storePath: target.storePath });
          expect(owner.reader.storePaths).toContain(target.storePath);
          const { replyOperation } = createMockReplyOperation({
            key: recipient.sessionKey,
            sessionId: recipient.sessionId,
          });
          lifecycleAdmissionByOperation.set(replyOperation, { reader: owner.reader });
          const followupRun = createMockFollowupRun({
            conversationParticipant: person,
            run: {
              ...target,
              config: fixture.cfg,
            },
          });
          const admission = prepareAgentRunAdmission({
            cfg: fixture.cfg,
            operationalRunInstance: createOperationalRunInstanceRef(runId),
            assertSourceCurrent: owner.assertCurrent,
            facts: {
              runId,
              agentId: recipient.agentId,
              ingress: { kind: "channel", boundary: "knowledge-writer-test", state: "present" },
            },
          });
          const knowledge = createReplyConversationKnowledgeTurn({
            turn: { isHeartbeat: false, followupRun, replyOperation },
            originalSource: owner.assertCurrent,
            getRuntimeConfig: () => fixture.cfg,
          });
          if (!knowledge) {
            throw new Error("Actual native knowledge owner missing");
          }
          try {
            await knowledge.prepare(admission, signal);
            const run = {
              ...followupRun.run,
              runId,
              prompt: "Which color?",
              sessionTarget: writer,
              contextTokenBudget: 100_000,
              runtimeContextFragments: [...knowledge.fragments],
            };
            await expect(
              withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
                knowledge.prepareHistory(run),
              ),
            ).resolves.toEqual([]);
            const packets = (await loadTranscriptEvents(recipient))
              .map(asOptionalRecord)
              .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT);
            expect(packets).toHaveLength(1);
            expect(packets[0]?.content).toContain("The color is yellow.");
            expect(budget.compact).toHaveBeenCalled();
            await knowledge.prepareHistory(run);
            expect(
              (await loadTranscriptEvents(recipient))
                .map(asOptionalRecord)
                .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT),
            ).toEqual(packets);
          } finally {
            knowledge.release();
            admission.close();
            lifecycleAdmissionByOperation.delete(replyOperation);
          }
        } finally {
          await fixture.close();
        }
      },
    );
  });
});
