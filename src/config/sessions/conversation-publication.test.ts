import { expect, it } from "vitest";
import {
  createConversationKnowledgeScenario,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { buildPersistedVoiceMessage } from "../../talk/voice-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import {
  startConversationKnowledgePublication,
  waitForConversationKnowledgePublication,
} from "./conversation-publication-reconcile.js";
import { openConversationPublicationStore } from "./conversation-publication.js";
import type { ConversationPublicationIntent } from "./conversation-publication.types.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";

// Real native append and worker transactions prove atomic provenance, exact acceptance,
// recovery, and FIFO. No model/provider execution or transcript task replay is involved.
it("journals native terminals atomically and settles only the exact accepted candidate", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "conversation-publication-journal" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        const source = await fixture.branch("journal");
        const owner = await fixture.claim(source);
        const branch = await readConversationKnowledgeBranch(owner);
        if (!branch) {
          throw new Error("Expected an enrolled branch");
        }
        const target = {
          agentId: source.agentId,
          path: source.storePath,
          env: source.env,
          assertCurrent: owner.assertCurrent,
        };
        let journal = openConversationPublicationStore(target);
        const admission = await appendTranscriptMessage(source, {
          message: { role: "user", content: "Remember this exchange.", timestamp: 1 },
        });
        if (!admission.anchor) {
          throw new Error("Expected native admission");
        }
        // Prior frontiers accumulate across origins, independently of the per-turn
        // text budget. Retaining them must not impose a smaller transcript limit.
        const observed = Array.from({ length: 512 }, (_, index) => ({
          origin: index.toString(16).padStart(64, "0"),
          generation: `observed-generation-${index}`,
          throughEntryId: `observed-endpoint-${index}`,
          throughRawSeq: index,
        }));
        expect(Buffer.byteLength(JSON.stringify(observed))).toBeGreaterThan(64 * 1024);
        const intent = (runId: string): ConversationPublicationIntent => ({
          version: 1,
          kind: "completed-turn",
          runId,
          sourceMode: "branches",
          source,
          root: branch.root,
          privateAudience: { participant: person, admission: admission.anchor! },
          observed,
        });
        const terminal = async (runId: string, suffix = "terminal") => {
          await upsertSessionEntryCore(source, { activeWriterRunId: `writer-${runId}` });
          const message = {
            role: "assistant",
            content: [{ type: "text", text: `${runId} ${suffix}` }],
            stopReason: "stop",
            timestamp: 2,
            idempotencyKey: `${runId}:${suffix}`,
            __openclaw: { runId },
          };
          const options = { message, conversationPublication: intent(runId) };
          const saved = await appendTranscriptMessage(source, options);
          if (!saved.anchor) {
            throw new Error("Expected native terminal");
          }
          return { options, anchor: saved.anchor };
        };
        const beforeUnowned = await loadTranscriptEvents(source);
        await expect(
          appendTranscriptMessage(source, {
            message: {
              role: "assistant",
              content: "Unowned candidate",
              stopReason: "stop",
              timestamp: 2,
              __openclaw: { runId: "unowned" },
            },
            conversationPublication: intent("unowned"),
          }),
        ).rejects.toThrow("not its admitted terminal");
        expect(await loadTranscriptEvents(source)).toEqual(beforeUnowned);
        const provisional = await terminal("first", "provisional");
        const accepted = await terminal("first");
        expect(await journal.stats()).toEqual([{ state: "candidate", count: 2 }]);
        expect(await journal.readReadyHeads({ now: Date.now(), limit: 8 })).toEqual([]);
        const acceptance = {
          sessionKey: source.sessionKey,
          sessionId: source.sessionId,
          lifecycleRevision: source.lifecycleRevision,
          runId: "first",
          entryId: accepted.anchor.entryId,
          idempotencyKey: accepted.options.message.idempotencyKey,
        };
        expect(await journal.accept({ ...acceptance, runId: "unrelated" })).toBeUndefined();
        expect(
          await journal.accept({
            ...acceptance,
            entryId: provisional.anchor.entryId,
          }),
        ).toBeUndefined();
        const firstId = await journal.accept(acceptance);
        expect(firstId).toEqual(expect.any(String));
        expect(await journal.accept(acceptance)).toBe(firstId);
        expect(await journal.stats()).toEqual(
          expect.arrayContaining([
            { state: "blocked", count: 1 },
            { state: "ready", count: 1 },
          ]),
        );
        const first = (await journal.readReadyHeads({ now: Date.now(), limit: 8 }))[0]!;
        expect(first).toMatchObject({
          id: firstId,
          anchor: accepted.anchor,
          intent: { privateAudience: { admission: admission.anchor, participant: person } },
        });
        expect(first.intent.observed).toEqual(observed);

        const beforeFailedAppend = await loadTranscriptEvents(source);
        await expect(
          appendTranscriptMessage(source, {
            message: {
              ...accepted.options.message,
              idempotencyKey: "invalid-root",
            },
            conversationPublication: {
              ...intent("first"),
              root: { ...branch.root, lifecycleRevision: "replaced-root" },
            },
          }),
        ).rejects.toThrow("enrollment changed");
        expect(await loadTranscriptEvents(source)).toEqual(beforeFailedAppend);
        expect(await journal.stats()).toEqual(
          expect.arrayContaining([
            { state: "blocked", count: 1 },
            { state: "ready", count: 1 },
          ]),
        );

        // Reopening the facade retains persisted work; no captured turn callback is needed.
        journal = openConversationPublicationStore(target);
        const abandoned = await terminal("abandoned");
        const second = await terminal("second");
        const secondId = await journal.accept({
          ...acceptance,
          runId: "second",
          entryId: second.anchor.entryId,
          idempotencyKey: second.options.message.idempotencyKey,
        });
        expect(secondId).toEqual(expect.any(String));
        await expect(
          journal.accept({
            ...acceptance,
            runId: "abandoned",
            entryId: abandoned.anchor.entryId,
            idempotencyKey: abandoned.options.message.idempotencyKey,
          }),
        ).rejects.toThrow("original native writer");
        const retryAt = Date.now() + 60_000;
        await journal.retry(first.id, { errorCode: "root-unavailable", nextAttemptAt: retryAt });
        expect(await journal.readReadyHeads({ now: retryAt - 1, limit: 8 })).toEqual([]);
        // A later same-origin ready row at time 0 must not cause a recovery busy loop.
        expect(await journal.nextAttemptAt()).toBe(retryAt);
        expect(
          (await journal.readReadyHeads({ now: retryAt, limit: 8 })).map((row) => row.id),
        ).toEqual([firstId]);
        await journal.acknowledge(first.id);
        expect(
          (await journal.readReadyHeads({ now: retryAt, limit: 8 })).map((row) => row.id),
        ).toEqual([secondId]);
        // Idempotent native message replay does not recreate already delivered work.
        expect((await appendTranscriptMessage(source, accepted.options)).appended).toBe(false);
        expect(await journal.accept(acceptance)).toBeUndefined();

        // An unresolved older candidate and a blocked origin never starve eligible voice work.
        await terminal("unsettled");
        await journal.block(secondId!, { errorCode: "source-unavailable" });
        const voice = await appendTranscriptMessage(source, {
          message: buildPersistedVoiceMessage({
            role: "user",
            text: "A separate voice occurrence.",
            timestamp: 3,
            provider: "example",
          }),
          conversationPublication: {
            version: 1,
            kind: "utterance-observation",
            role: "user",
            sourceMode: "branches",
            source,
            root: branch.root,
            privateAudience: { participant: person, admission: "self" },
          },
        });
        const readyVoice = await journal.readReadyHeads({ now: retryAt, limit: 8 });
        expect(readyVoice).toHaveLength(1);
        expect(readyVoice[0]).toMatchObject({
          state: "ready",
          anchor: voice.anchor,
          intent: {
            kind: "utterance-observation",
            privateAudience: {
              participant: person,
              admission: voice.anchor,
            },
          },
        });
        expect(await journal.nextAttemptAt()).toBe(0);
        // Exercise the real background owner alongside native conversation
        // catalogue publication, whose independent singleton must stay intact.
        startConversationKnowledgePublication(target);
        await waitForConversationKnowledgePublication(target);
        expect(await journal.nextAttemptAt()).toBeUndefined();
        expect(await journal.stats()).toEqual(
          expect.arrayContaining([
            { state: "candidate", count: 2 },
            { state: "blocked", count: 2 },
          ]),
        );
      } finally {
        await fixture.close();
      }
    },
  );
});
