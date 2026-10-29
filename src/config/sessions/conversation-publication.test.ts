import { expect, it, vi } from "vitest";
import {
  createConversationKnowledgeScenario,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { bindConversationInputPublication } from "../../auto-reply/reply/conversation-publication-input.js";
import {
  attachRuntimeUserTurnTranscriptRecorder,
  withRuntimeUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript-runtime-context.js";
import { confirmPersistedSteerTargetRunId } from "../../sessions/user-turn-transcript-updates.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { buildPersistedVoiceMessage } from "../../talk/voice-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { selectConversationKnowledgeReceipts } from "./conversation-knowledge-selection.js";
import { readConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import { projectConversationKnowledge } from "./conversation-knowledge.js";
import { withConversationPublicationContext } from "./conversation-publication-context.js";
import {
  startConversationKnowledgePublication,
  waitForConversationKnowledgePublication,
} from "./conversation-publication-reconcile.js";
import { openConversationPublicationStore } from "./conversation-publication.js";
import type { ConversationPublicationIntent } from "./conversation-publication.types.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";

const wake = vi.hoisted(() => vi.fn());
// mock-isolation: Inspect original COMMIT/wakeup ordering before explicitly draining the real journal.
vi.mock("./conversation-publication-wakeup.js", () => ({ wakeConversationPublication: wake }));

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

it("publishes original input, steered input and commentary before final completion without recopying them", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "early-conversation-publication" },
    async (state) => {
      wake.mockClear();
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        const source = await fixture.branch("early-original");
        const owner = await fixture.claim(source);
        const branch = await readConversationKnowledgeBranch(owner);
        const entry = loadSessionEntry(source);
        if (!branch || !entry) {
          throw new Error("Expected the original enrolled branch");
        }
        let current = true;
        const assertCurrent = () => {
          owner.assertCurrent();
          if (!current) {
            throw new Error("Original audience revoked");
          }
        };
        const makeInput = (key: string, text: string) => {
          const recorder = createUserTurnTranscriptRecorder({
            input: { text, idempotencyKey: key },
            target: { ...source, sessionEntry: entry, config: fixture.cfg },
          });
          bindConversationInputPublication({
            ...source,
            entry,
            assertCurrent,
            recorder,
            config: fixture.cfg,
            participant: person,
            audience: {
              ...source,
              channelId: "matrix",
              accountId: "example",
              nativeChannelId: "example-room",
              participant: person,
              assertCurrent,
            },
          });
          return recorder;
        };
        const first = makeInput("input-one", "Remember the blue circle.");
        const savedFirst = await first.persistApproved();
        expect(savedFirst?.admission).toBeDefined();
        const target = { agentId: source.agentId, path: source.storePath, env: source.env };
        const journal = openConversationPublicationStore({ ...target, assertCurrent });
        expect(await journal.stats()).toEqual([{ state: "ready", count: 1 }]);
        expect(wake).toHaveBeenCalled();
        await first.captureModelPromptProjection?.(
          "A derived prompt, not the original utterance.",
          assertCurrent,
        );
        const [projectedInput] = await journal.readReadyHeads({ now: Date.now(), limit: 8 });
        expect(projectedInput?.readRange?.through.generation).toBe(
          first.getAdmissionReceipt()?.generation,
        );
        expect(projectedInput?.anchor.generation).not.toBe(first.getAdmissionReceipt()?.generation);
        const beforeRollback = await loadTranscriptEvents(source);
        const wakesBeforeRollback = wake.mock.calls.length;
        await expect(
          appendTranscriptMessage(source, {
            message: {
              role: "user",
              content: "Wrong original identity.",
              idempotencyKey: "other-input",
              timestamp: 2,
            },
            conversationPublication: {
              version: 1,
              kind: "utterance-observation",
              role: "user",
              inputKey: "different-input",
              sourceMode: "branches",
              source,
              root: branch.root,
              privateAudience: { participant: person, admission: "self" },
            },
          }),
        ).rejects.toThrow("original native");
        expect(await loadTranscriptEvents(source)).toEqual(beforeRollback);
        expect(await journal.stats()).toEqual([{ state: "ready", count: 1 }]);
        expect(wake).toHaveBeenCalledTimes(wakesBeforeRollback);
        await upsertSessionEntryCore(source, { activeWriterRunId: "writer-one" });
        const second = makeInput("input-two", "Also remember the green square.");
        if (!second.message) {
          throw new Error("Expected the steered original input");
        }
        const assistantIntent: ConversationPublicationIntent = {
          version: 1,
          kind: "utterance-observation",
          role: "assistant",
          runId: "run-one",
          sourceMode: "branches",
          source,
          root: branch.root,
          privateAudience: { participant: person, admission: savedFirst!.admission },
        };
        await withConversationPublicationContext(
          {
            source,
            storePath: source.storePath,
            recorder: first,
            runId: "run-one",
            capture: () => ({
              intent: {
                ...assistantIntent,
                privateAudience: { participant: person, admission: first.getAdmissionReceipt()! },
              },
              assertCurrent,
            }),
          },
          async () => {
            const runtimeMessage = attachRuntimeUserTurnTranscriptRecorder(second.message!, second);
            const savedSecond = await withRuntimeUserTurnTranscriptRecorder(runtimeMessage, () =>
              appendTranscriptMessage(source, { message: runtimeMessage }),
            );
            expect(savedSecond.anchor).toBeDefined();
            const beforeSteerGeneration = first.getAdmissionReceipt()?.generation;
            const steered = await confirmPersistedSteerTargetRunId({
              admission: { ...savedSecond.anchor!, logicalTurnId: "input-two", role: "user" },
              targetRunId: "run-one",
            });
            expect(steered).toBeDefined();
            expect(first.getAdmissionReceipt()?.generation).toBe(steered!.admission.generation);
            expect(first.getAdmissionReceipt()?.generation).not.toBe(beforeSteerGeneration);
            await appendTranscriptMessage(source, {
              message: {
                role: "user",
                content: "A reflected observation, not a fresh request.",
                idempotencyKey: "mirror-one",
                provenance: { kind: "inter_session" },
                timestamp: 3,
              },
            });
            expect(await journal.stats()).toEqual([{ state: "ready", count: 2 }]);
            const commentary = {
              role: "assistant",
              stopReason: "toolUse",
              endTurn: false,
              content: [
                { type: "text", text: "I am checking both shapes." },
                { type: "thinking", thinking: "Private reasoning." },
                {
                  type: "toolCall",
                  id: "call-one",
                  name: "example",
                  arguments: { private: "value" },
                },
              ],
              timestamp: 3,
              __openclaw: { runId: "run-one" },
            };
            await appendTranscriptMessage(source, { message: commentary });
            expect(await journal.stats()).toEqual([{ state: "ready", count: 3 }]);
            const beforeRevoked = await loadTranscriptEvents(source);
            current = false;
            await expect(
              appendTranscriptMessage(source, {
                message: { ...commentary, idempotencyKey: "revoked" },
              }),
            ).rejects.toThrow("revoked");
            expect(await loadTranscriptEvents(source)).toEqual(beforeRevoked);
            current = true;
            await appendTranscriptMessage(source, {
              message: {
                role: "assistant",
                content: "Both shapes are noted.",
                stopReason: "stop",
                timestamp: 4,
                __openclaw: { runId: "run-one" },
              },
            });
          },
        );
        expect(await journal.stats()).toEqual([{ state: "ready", count: 4 }]);
        startConversationKnowledgePublication(target);
        await waitForConversationKnowledgePublication(target);
        const receipts = selectConversationKnowledgeReceipts(
          await loadTranscriptEvents(fixture.root),
          "other",
        );
        expect(receipts).toHaveLength(4);
        expect(receipts.every((receipt) => "kind" in receipt)).toBe(true);
        const events = await loadTranscriptEvents(source);
        const observations = receipts.flatMap((receipt) => {
          const projected = projectConversationKnowledge(receipt, events);
          return JSON.parse(projected?.text ?? "{}").observations;
        });
        expect(observations).toEqual([
          { speaker: "user", text: "Remember the blue circle." },
          { speaker: "user", text: "Also remember the green square." },
          { speaker: "assistant", text: "I am checking both shapes." },
          { speaker: "assistant", text: "Both shapes are noted." },
        ]);
        expect(JSON.stringify(observations)).not.toMatch(/Private reasoning|private|toolCall/);
        expect(await journal.stats()).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );
});
