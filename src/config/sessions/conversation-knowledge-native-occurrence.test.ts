import { expect, it } from "vitest";
import {
  createConversationKnowledgeScenario,
  otherPerson,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { recordConversationKnowledgeTurn } from "./conversation-knowledge-store.js";
import { appendTranscriptMessage, loadTranscriptEvents } from "./session-accessor.js";

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
