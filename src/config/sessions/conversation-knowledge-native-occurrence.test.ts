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
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "./session-accessor.reset.js";
import {
  buildForkedChildTranscriptEvents,
  resolveParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import type { PreparedInitialSessionContext } from "./session-initial-context.js";
import type {
  PreparedSessionSourceAuthority,
  SessionSourceAssertion,
} from "./session-source-authority.js";
import { readActiveTranscriptEntryAnchorAsync } from "./session-transcript-anchor-read.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";

it("seeds only a copied child's own tail, not its natively inherited completed prefix", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "native-copied-prefix-seed" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        const donor = await fixture.branch("copied-prefix-donor");
        const donorOwner = await fixture.claim(donor);
        const terminal = await fixture.append(donor, "original-donor-run");
        expect(
          await recordConversationKnowledgeTurn({
            ...donorOwner,
            ...terminal,
            privateAudience: { participant: person, admission: terminal.admission! },
          }),
        ).toBe(true);
        const child = {
          ...donor,
          sessionKey: "agent:main:copied-prefix-child",
          sessionId: "copied-prefix-child",
          lifecycleRevision: "copied-prefix-child-life",
        };
        const snapshot = await loadReplySessionInitializationSnapshot(child);
        await withSessionEntryReadOnlyInWorker(
          donor,
          () => {},
          async (read, owner) => {
            if (!read.ok) {
              throw read.error;
            }
            if (!read.value || !owner.source || typeof owner.source.databaseIdentity !== "string") {
              throw new Error("Expected the actual donor's admitted native read source");
            }
            const hydration = await prepareSessionTranscriptHydration(donor).read();
            if (hydration.kind !== "full") {
              throw new Error("Expected the native donor transcript");
            }
            const selected = resolveParentForkSourceTranscript(
              hydration.snapshot.events,
              "last-completed",
            );
            if (!selected?.leafId) {
              throw new Error("Expected the donor's completed prefix");
            }
            const sourceThrough = await readActiveTranscriptEntryAnchorAsync({
              ...donor,
              entryId: selected.leafId,
            });
            if (!sourceThrough) {
              throw new Error("Expected the exact inherited source endpoint");
            }
            const context: PreparedInitialSessionContext = {
              source: { ...owner.source, databaseIdentity: owner.source.databaseIdentity },
              sourceSessionKey: donor.sessionKey,
              sourceEntry: {
                sessionId: read.value.sessionId,
                lifecycleRevision: read.value.lifecycleRevision,
              },
              sourceVersion: hydration.snapshot.version,
              sourceThrough,
              targetSessionId: child.sessionId,
              events: buildForkedChildTranscriptEvents({
                parentSessionFile: donor.sessionKey,
                source: selected,
                targetSessionId: child.sessionId,
              }),
            };
            // The storage test retains the actual native read owner and its source
            // predicates. It does not forge forkSource or bypass the creation worker.
            const contextSourceAuthority: SessionSourceAssertion = Object.assign(
              () => owner.assertCurrent(),
              {
                prepareSessionSource: async (): Promise<PreparedSessionSourceAuthority> => ({
                  assertCurrent: owner.assertCurrent,
                  checks: [
                    {
                      predicate: {
                        source: context.source,
                        sessionKey: donor.sessionKey,
                        fields: [
                          "sessionId",
                          "lifecycleRevision",
                          "createdActor",
                          "visibility",
                          "incognito",
                        ],
                        expected: read.value,
                      },
                      refuse: (): never => {
                        throw new Error("Synthetic donor read witness changed");
                      },
                    },
                  ],
                }),
              },
            );
            expect(
              await commitReplySessionInitialization({
                ...child,
                activeSessionKey: child.sessionKey,
                expectedRevision: snapshot.revision,
                commitGuard: owner.assertCurrent,
                contextSourceAuthority,
                initialContext: context,
                branchRootSessionKey: fixture.root.sessionKey,
                sessionEntry: {
                  sessionId: child.sessionId,
                  lifecycleRevision: child.lifecycleRevision,
                  updatedAt: Date.now(),
                  chatType: "direct",
                  visibility: "draft",
                },
              }),
            ).toMatchObject({ ok: true });
          },
        );
        const childOwner = await fixture.claim(child);
        await fixture.append(child, "new-child-run");
        const before = await loadTranscriptEvents(child);
        expect(JSON.stringify(before)).toContain("original-donor-run answer");
        expect(await ensureConversationKnowledgeSeed(childOwner)).toMatchObject({
          status: "seeded",
          recorded: 1,
        });
        const reports = await fixture.receipts();
        expect(reports.map((receipt) => [receipt.source.sessionId, receipt.runId])).toEqual([
          [donor.sessionId, "original-donor-run"],
          [child.sessionId, "new-child-run"],
        ]);
        expect(await loadTranscriptEvents(child)).toEqual(before);
      } finally {
        await fixture.close();
      }
    },
  );
});

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
            timestamp: "2026-01-01T00:00:01.000Z",
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
