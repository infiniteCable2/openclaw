import { expect, it } from "vitest";
import {
  createConversationKnowledgeScenario,
  otherPerson,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  CONVERSATION_KNOWLEDGE_SEED,
  ensureConversationKnowledgeSeed,
} from "./conversation-knowledge-seed.js";
import {
  ConversationKnowledgeSourceCapacityError,
  recordConversationKnowledgeTurn,
} from "./conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
  conversationKnowledgeOrigin,
  isCompletedConversationKnowledge,
} from "./conversation-knowledge.js";
import { appendTranscriptMessage, loadTranscriptEvents } from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { readActiveTranscriptEntryAnchorAsync } from "./session-transcript-anchor-read.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";

it("keeps one real completed turn beyond the validation event budget pending, not skipped", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "native-long-turn-seed" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        const branch = await fixture.branch("long-turn");
        const owner = await fixture.claim(branch);
        const events: TranscriptEvent[] = [
          {
            type: "message",
            id: "long-question",
            parentId: null,
            message: { role: "user", content: "Complete this long exchange.", timestamp: 1 },
          },
        ];
        // Every small carrier is on the same uncompacted active path. The full
        // exchange is valid, but the bounded native view cannot retain its user.
        for (let index = 0; index < CONVERSATION_KNOWLEDGE_SOURCE_LIMITS.maxEvents; index += 1) {
          events.push({
            type: "custom_message",
            id: `context-${index}`,
            parentId: index === 0 ? "long-question" : `context-${index - 1}`,
            customType: "synthetic-context",
            content: "Small context carrier.",
            display: false,
          });
        }
        events.push({
          type: "message",
          id: "long-answer",
          parentId: `context-${CONVERSATION_KNOWLEDGE_SOURCE_LIMITS.maxEvents - 1}`,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "The long exchange is complete." }],
            stopReason: "stop",
            timestamp: 2,
            __openclaw: { runId: "long-run" },
          },
        });
        await replaceTranscriptEvents(branch, events);
        await waitForSessionTranscriptProjection(branch);
        const storedBefore = await loadTranscriptEvents(branch);
        const through = await readActiveTranscriptEntryAnchorAsync({
          ...branch,
          entryId: "long-answer",
        });
        if (!through) {
          throw new Error("Expected the real saved terminal anchor");
        }
        expect(
          isCompletedConversationKnowledge(
            {
              version: 1,
              sourceMode: "branches",
              source: branch,
              origin: conversationKnowledgeOrigin(branch),
              runId: "long-run",
              through,
            },
            storedBefore,
          ),
        ).toBe(true);
        await expect(
          recordConversationKnowledgeTurn({
            ...owner,
            runId: "long-run",
            assistantTranscriptEntryId: "long-answer",
          }),
        ).rejects.toBeInstanceOf(ConversationKnowledgeSourceCapacityError);
        expect(await ensureConversationKnowledgeSeed(owner)).toMatchObject({
          status: "pending",
          reason: "source-capacity",
          recorded: 0,
        });
        expect(await fixture.receipts()).toEqual([]);
        expect(await loadTranscriptEvents(fixture.root)).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ customType: CONVERSATION_KNOWLEDGE_SEED }),
          ]),
        );
        expect(await loadTranscriptEvents(branch)).toEqual(storedBefore);
      } finally {
        await fixture.close();
      }
    },
  );
});

it("publishes an unkeyed native call completion through the root to its private chat", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "native-call-root-chat" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        const call = await fixture.branch("native-call");
        const chat = await fixture.branch("private-chat");
        const foreign = await fixture.branch("foreign-chat", otherPerson);
        const callOwner = await fixture.claim(call);
        const chatOwner = await fixture.claim(chat);
        const foreignOwner = await fixture.claim(foreign);
        const user = await appendTranscriptMessage(call, {
          message: { role: "user", content: "Remember the colour blue.", timestamp: 1 },
        });
        const assistant = await appendTranscriptMessage(call, {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Blue, understood." }],
            stopReason: "stop",
            timestamp: 2,
            __openclaw: { runId: "native-call-run" },
          },
        });
        if (!user.anchor || !assistant.anchor) {
          throw new Error("Expected the actual committed user and assistant anchors");
        }
        const receipt = {
          ...callOwner,
          runId: "native-call-run",
          assistantTranscriptEntryId: assistant.anchor.entryId,
          privateAudience: { participant: person, admission: user.anchor },
        };
        expect(await recordConversationKnowledgeTurn(receipt)).toBe(true);
        expect(await recordConversationKnowledgeTurn(receipt)).toBe(true);
        const reports = await fixture.receipts();
        expect(reports).toHaveLength(1);
        expect(reports[0]?.through.entryId).toBe(assistant.anchor.entryId);
        expect((await fixture.read(chatOwner)).text).toContain("Blue, understood.");
        expect((await fixture.read(foreignOwner, otherPerson)).text).not.toContain(
          "Blue, understood.",
        );
        expect(await loadTranscriptEvents(call)).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: assistant.anchor.entryId })]),
        );

        expect(await recordConversationKnowledgeTurn({ ...receipt, runId: "unrelated-run" })).toBe(
          false,
        );
        expect(
          await recordConversationKnowledgeTurn({
            ...receipt,
            assistantTranscriptEntryId: user.anchor.entryId,
          }),
        ).toBe(false);
        expect(
          await recordConversationKnowledgeTurn({
            ...receipt,
            assistantTranscriptEntryId: undefined,
          }),
        ).toBe(false);
        expect(
          await recordConversationKnowledgeTurn({
            ...receipt,
            assistantTranscriptIdempotencyKey: "unrelated-key",
          }),
        ).toBe(false);

        for (const stopReason of ["error", "aborted", "toolUse"]) {
          const runId = `uncompleted-${stopReason}`;
          await appendTranscriptMessage(call, {
            message: { role: "user", content: "An unfinished request.", timestamp: 3 },
          });
          const unfinished = await appendTranscriptMessage(call, {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Not a completed answer." }],
              stopReason,
              timestamp: 4,
              __openclaw: { runId },
            },
          });
          if (!unfinished.anchor) {
            throw new Error("Expected the committed unfinished occurrence");
          }
          expect(
            await recordConversationKnowledgeTurn({
              ...callOwner,
              runId,
              assistantTranscriptEntryId: unfinished.anchor.entryId,
            }),
          ).toBe(false);
        }
        expect(await fixture.receipts()).toHaveLength(1);

        const keyed = await fixture.append(call, "keyed-next-run");
        expect(await recordConversationKnowledgeTurn({ ...callOwner, ...keyed })).toBe(true);
        expect(
          await recordConversationKnowledgeTurn({
            ...callOwner,
            ...keyed,
            assistantTranscriptEntryId: assistant.anchor.entryId,
          }),
        ).toBe(false);
      } finally {
        await fixture.close();
      }
    },
  );
});
