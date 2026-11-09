import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "../../agents/embedded-agent-runner/compact.types.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { CONVERSATION_KNOWLEDGE_CONTEXT } from "../../config/sessions/conversation-knowledge-packets.js";
import { recordConversationKnowledgeTurn } from "../../config/sessions/conversation-knowledge-store.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../../config/sessions/session-message-rewrite.js";
import {
  addSessionMemberInWorker,
  removeSessionMemberInWorker,
} from "../../config/sessions/session-sharing-store.async.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { lifecycleAdmissionByOperation } from "../../sessions/session-controller.state.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createReplyConversationKnowledgeTurn } from "./conversation-knowledge-turn.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";
import { createMockFollowupRun, createMockReplyOperation } from "./test-helpers.js";

const budget = vi.hoisted(() => ({
  compact: vi.fn(async (params: CompactEmbeddedAgentSessionRuntimeParams) => {
    params.budgetPreflight?.onDecision?.(true);
    return { ok: true, compacted: false, reason: "within budget" };
  }),
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
          expect(
            await recordConversationKnowledgeTurn({
              ...donorOwner,
              ...terminal,
              privateAudience: { participant: person, admission: terminal.admission! },
            }),
          ).toBe(true);
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
            turn: { followupRun, replyOperation },
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

            // A preview still borrows the donor's live authority. A successful
            // native copy belongs to the recipient and must not borrow it for
            // the rest of its foreground model/tool/speech admission.
            const previewBranch = await fixture.branch("preview-recipient");
            const preview = await prepareReplyConversationKnowledge({
              ...(await fixture.claim(previewBranch)),
              originalParticipant: person,
              getRuntimeConfig: () => fixture.cfg,
            });
            if (!preview) {
              throw new Error("Expected live native preview authority");
            }
            try {
              expect(preview.fragments.map((fragment) => fragment.text).join("\n")).toContain(
                "The color is yellow.",
              );
              preview.assertCurrent();
              const changed = await addSessionMemberInWorker(donor, {
                identityId: "synthetic-other-reader",
                addedBy: "synthetic-owner",
                expectedSessionId: donor.sessionId,
              });
              expect(changed.inserted).toBe(true);
              expect(() => preview.assertCurrent()).toThrow();
              expect(() => owner.assertCurrent()).not.toThrow();
              expect(() => knowledge.assertCurrent()).not.toThrow();
              expect(
                (await loadTranscriptEvents(recipient))
                  .map(asOptionalRecord)
                  .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT),
              ).toEqual(packets);
            } finally {
              preview.release();
              await removeSessionMemberInWorker(
                donor,
                "synthetic-other-reader",
                undefined,
                donor.sessionId,
              );
            }

            await knowledge.prepareHistory(run);
            expect(
              (await loadTranscriptEvents(recipient))
                .map(asOptionalRecord)
                .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT),
            ).toEqual(packets);

            // A later native prompt-metadata rewrite must preserve older private
            // contributions for both an existing call and a newly admitted one.
            const later = await appendTranscriptMessage(donor, {
              message: { role: "user", content: "A later unrelated turn.", timestamp: Date.now() },
            });
            if (!later.anchor) {
              throw new Error("Expected later native user anchor");
            }
            const rewritten = await rewritePreparedTranscriptMessageAtAnchor(
              later.anchor,
              (message) => {
                const current = asOptionalRecord(message);
                if (current?.role !== "user") {
                  throw new Error("Expected original later user message");
                }
                return {
                  ...current,
                  __openclaw: {
                    ...asOptionalRecord(current["__openclaw"]),
                    modelPromptProjection: { version: 1, text: "Prepared later model view." },
                  },
                };
              },
            );
            expect(rewritten?.generation).not.toBe(later.anchor.generation);
            const refreshed = (await fixture.receipts())[0]!;
            expect(refreshed.through.generation).toBe(terminal.admission!.generation);
            expect(refreshed.readRange?.through.generation).toBe(rewritten?.generation);
            await knowledge.prepareHistory(run);
            expect(
              (await loadTranscriptEvents(recipient))
                .map(asOptionalRecord)
                .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT),
            ).toEqual(packets);
            const fresh = await fixture.branch("fresh-recipient");
            expect((await fixture.read(await fixture.claim(fresh))).text).toContain(
              "The color is yellow.",
            );

            // Copy ownership never replaces the recipient's current authority.
            await upsertSessionEntryCore(recipient, {
              ...loadSessionEntry(recipient)!,
              incognito: true,
            });
            expect(() => owner.assertCurrent()).not.toThrow();
            expect(() => knowledge.assertCurrent()).toThrow();
            owner.revoke();
            expect(() => knowledge.assertCurrent()).toThrow("Original scenario input revoked");
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
