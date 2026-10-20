import { expect, it, vi } from "vitest";
import {
  createConversationKnowledgeScenario,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import { withConversationPublicationContext } from "./conversation-publication-context.js";
import { openConversationPublicationStore } from "./conversation-publication.js";
import type { ConversationPublicationIntent } from "./conversation-publication.types.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import {
  appendTranscriptMessage,
  withTranscriptWriteLock,
} from "./session-accessor.sqlite-transcript-write.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";

// One real native fixture covers worker and retained synchronous compatibility routes.
it("captures both locked append variants before preparation and retains original commit authority", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "conversation-publication-locked" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        for (const native of [false, true]) {
          for (const sequenced of [false, true]) {
            const runId = `locked-${native}-${sequenced}`;
            const source = await fixture.branch(runId);
            await upsertSessionEntryCore(source, { activeWriterRunId: runId });
            const owner = await fixture.claim(source);
            const branch = await readConversationKnowledgeBranch(owner);
            if (!branch) {
              throw new Error("Expected an enrolled branch");
            }
            const admission = await appendTranscriptMessage(source, {
              message: { role: "user", content: "Original caller.", timestamp: 1 },
            });
            if (!admission.anchor) {
              throw new Error("Expected admission anchor");
            }
            const intent: ConversationPublicationIntent = {
              version: 1,
              kind: "completed-turn",
              runId,
              sourceMode: "branches",
              source: {
                sessionKey: source.sessionKey,
                sessionId: source.sessionId,
                lifecycleRevision: source.lifecycleRevision,
              },
              root: branch.root,
              privateAudience: { participant: person, admission: admission.anchor },
            };
            let current = true;
            const assertOriginal = () => {
              if (!current) {
                throw new Error("Original append source revoked");
              }
            };
            const originalSource: SessionSourceAssertion = Object.assign(
              assertOriginal,
              native
                ? { nativeSource: true }
                : {
                    prepareSessionSource: async () => ({
                      assertCurrent: assertOriginal,
                      checks: [],
                    }),
                  },
            );
            const capture = vi.fn(() => ({ intent, assertCurrent: owner.assertCurrent }));
            const message = {
              role: "assistant",
              content: "Committed answer.",
              stopReason: "stop",
              idempotencyKey: `${runId}:terminal`,
              __openclaw: { runId },
            };
            const saved = await withConversationPublicationContext({ source, runId, capture }, () =>
              withTranscriptWriteLock(source, async (locked) => {
                const queuedFirst = locked.appendMessage({
                  message: { role: "user", content: "Queued first.", timestamp: 2 },
                  preparation: {
                    prepareMessage: async (original) => {
                      await Promise.resolve();
                      intent.sourceMode = "native";
                      return original;
                    },
                  },
                });
                const options = {
                  message,
                  preparation: {
                    source: originalSource,
                    prepareMessage: async () => {
                      await Promise.resolve();
                      return message;
                    },
                  },
                };
                const pending = sequenced
                  ? locked.appendMessageWithMessageSequence(options).then((value) => value.result)
                  : locked.appendMessage(options);
                await queuedFirst;
                return await pending;
              }),
            );
            expect(capture).toHaveBeenCalledTimes(1);
            expect(saved?.anchor).toBeDefined();
            const journal = openConversationPublicationStore({
              agentId: source.agentId,
              path: source.storePath,
              env: source.env,
              assertCurrent: owner.assertCurrent,
            });
            expect(await journal.stats()).toEqual([{ state: "candidate", count: 1 }]);
            await journal.accept({
              ...intent.source,
              runId,
              entryId: saved!.anchor!.entryId,
              idempotencyKey: message.idempotencyKey,
            });
            const ready = (await journal.readReadyHeads({ now: Date.now(), limit: 8 }))[0]!;
            expect(ready).toMatchObject({
              anchor: saved!.anchor,
              intent: {
                sourceMode: "branches",
                privateAudience: { participant: person, admission: admission.anchor },
              },
            });
            await journal.acknowledge(ready.id);

            const before = await loadTranscriptEvents(source);
            await expect(
              withConversationPublicationContext({ source, runId, capture }, () =>
                withTranscriptWriteLock(source, async (locked) => {
                  const revoked = { ...message, idempotencyKey: `${runId}:revoked` };
                  const options = {
                    message: revoked,
                    preparation: {
                      source: originalSource,
                      prepareMessage: async () => {
                        await Promise.resolve();
                        current = false;
                        return revoked;
                      },
                    },
                  };
                  return sequenced
                    ? locked.appendMessageWithMessageSequence(options)
                    : locked.appendMessage(options);
                }),
              ),
            ).rejects.toThrow("Original append source revoked");
            expect(await loadTranscriptEvents(source)).toEqual(before);
            expect(await journal.stats()).toEqual([]);
          }
        }
      } finally {
        await fixture.close();
      }
    },
  );
});
