import { AsyncLocalStorage } from "node:async_hooks";
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { streamAgentResponse } from "../../../packages/agent-core/src/agent-stream-response.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { submitEmbeddedAttemptPrompt } from "../../agents/embedded-agent-runner/run/attempt-prompt-submit.js";
import { createBaseInput } from "../../agents/embedded-agent-runner/run/attempt-prompt-submit.test-support.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { beginForegroundSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { createCompactionRequestBudget } from "../../agents/sessions/compaction/request-budget.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import * as knowledgePacketReads from "../../config/sessions/conversation-knowledge-packets.js";
import * as knowledgeStoreReads from "../../config/sessions/conversation-knowledge-store.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SettledAgentTurn } from "./agent-runner-execution.types.js";
import { prepareConversationKnowledgeRecipient } from "./conversation-knowledge-prefetch.js";
import { createReplyConversationKnowledgeTurn } from "./conversation-knowledge-turn.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";
import { lifecycleAdmissionByOperation } from "./reply-run-registry.state.js";
import { createMockFollowupRun, createMockReplyOperation } from "./test-helpers.js";

const budget = vi.hoisted(() => ({ compact: vi.fn() }));
// mock-isolation: Background preparation and native consumption must never invoke model compaction.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: budget.compact,
}));

registerAgentSessionLoopTestLifecycle();

const { CONVERSATION_KNOWLEDGE_CONTEXT, conversationKnowledgeContributionId } =
  knowledgePacketReads;
const { readConversationKnowledgeBranch, recordConversationKnowledgeTurn } = knowledgeStoreReads;

describe("native branch prefetch and model-boundary composition", () => {
  it("prepares idle history on committed roots without recipient writes or model maintenance", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "knowledge-idle-readiness" },
      async (state) => {
        const fixture = await createConversationKnowledgeScenario(state);
        let prefetch: ReturnType<typeof prepareConversationKnowledgeRecipient>;
        let stopObservation = () => {};
        budget.compact.mockClear();
        try {
          const chat = await fixture.branch("earlier-chat");
          const previousCall = await fixture.branch("previous-call");
          const recipient = await fixture.branch("idle-recipient");
          const chatOwner = await fixture.claim(chat);
          const callOwner = await fixture.claim(previousCall);
          const publish = async (
            source: typeof chat,
            owner: typeof chatOwner,
            id: string,
            text: string,
          ) => {
            const terminal = await fixture.append(source, id, "stop", text);
            expect(
              await recordConversationKnowledgeTurn({
                ...owner,
                ...terminal,
                privateAudience: { participant: person, admission: terminal.admission! },
              }),
            ).toBe(true);
            const receipt = (await fixture.receipts()).find((value) => value.runId === id);
            if (!receipt) {
              throw new Error("Expected committed native source contribution");
            }
            return conversationKnowledgeContributionId(receipt);
          };
          const earlier: string[] = [];
          for (let index = 0; index < 9; index++) {
            earlier.push(
              await publish(
                chat,
                chatOwner,
                `earlier-chat-${index}`,
                `Earlier chat fact ${index}.`,
              ),
            );
          }
          const fresh = await publish(chat, chatOwner, "fresh-chat", "The chat codeword is amber.");
          const priorCall = await publish(
            previousCall,
            callOwner,
            "prior-call",
            "The previous call codeword is violet.",
          );
          const pendingFinalDelivery = {
            kind: "transport-only" as const,
            intentId: "synthetic-intent",
            deliveries: [{ id: "synthetic-delivery", state: "queued" as const }],
            createdAt: Date.now(),
          };
          await upsertSessionEntryCore(recipient, {
            ...loadSessionEntry(recipient)!,
            pendingFinalDelivery,
          });
          const before = await loadTranscriptEvents(recipient);
          const entryBefore = loadSessionEntry(recipient)!;
          const claim = await fixture.claim(recipient);
          const branch = await readConversationKnowledgeBranch(claim);
          if (!branch) {
            throw new Error("Expected actual native recipient membership");
          }
          let firstOpeningLive = true;
          let secondOpeningLive = true;
          let rootUpdates = 0;
          let recipientUpdates = 0;
          stopObservation = onInternalSessionTranscriptUpdate((update) => {
            if (update.target?.sessionId === branch.root.sessionId) {
              rootUpdates++;
            }
            if (update.target?.sessionId === recipient.sessionId) {
              recipientUpdates++;
            }
          });
          const audience: ConversationPrivateAudience = {
            agentId: branch.agentId,
            sessionKey: branch.sessionKey,
            channelId: "matrix",
            accountId: "default",
            nativeChannelId: "synthetic-private-idle-recipient",
            participant: person,
            assertCurrent() {
              claim.assertCurrent();
              if (!firstOpeningLive) {
                throw new Error("First native opening closed");
              }
            },
          };
          const request = {
            branch,
            participant: person,
            audience,
            env: state.env,
            getRuntimeConfig: () => fixture.cfg,
          };
          prefetch = prepareConversationKnowledgeRecipient(request);
          if (!prefetch) {
            throw new Error("Expected eligible native idle recipient");
          }
          await prefetch.owner.wait();
          for (const [index, id] of earlier.entries()) {
            expect(prefetch.cache.peek(id, 0)?.part.text).toContain(`Earlier chat fact ${index}.`);
          }
          expect(prefetch.cache.peek(fresh, 0)?.part.text).toContain("The chat codeword is amber.");
          expect(prefetch.cache.peek(priorCall, 0)?.part.text).toContain(
            "The previous call codeword is violet.",
          );
          expect(await loadTranscriptEvents(recipient)).toEqual(before);
          expect(loadSessionEntry(recipient)).toEqual(entryBefore);
          expect(rootUpdates).toBe(0);
          expect(recipientUpdates).toBe(0);
          expect(budget.compact).not.toHaveBeenCalled();

          const secondAudience: ConversationPrivateAudience = {
            ...audience,
            assertCurrent() {
              claim.assertCurrent();
              if (!secondOpeningLive) {
                throw new Error("Second native opening closed");
              }
            },
          };
          expect(
            prepareConversationKnowledgeRecipient({ ...request, audience: secondAudience }),
          ).toBe(prefetch);
          firstOpeningLive = false;
          await prefetch.owner.wait();
          const later = await publish(
            chat,
            chatOwner,
            "later-chat",
            "The later codeword is emerald.",
          );
          // Only the source's native commit wakes this already idle recipient.
          await prefetch.owner.wait();
          expect(prefetch.cache.peek(later, 0)?.part.text).toContain(
            "The later codeword is emerald.",
          );
          expect(rootUpdates).toBeGreaterThan(0);
          expect(recipientUpdates).toBe(0);
          expect(await loadTranscriptEvents(recipient)).toEqual(before);
          expect(loadSessionEntry(recipient)?.pendingFinalDelivery).toEqual(pendingFinalDelivery);
          const preparedPackets = () =>
            [...earlier, fresh, priorCall, later].map((id) => ({
              id,
              packet: prefetch!.cache.peek(id, 0),
            }));
          const preparedBefore = preparedPackets();
          const rootUpdatesBefore = rootUpdates;
          prefetch.owner.request();
          await prefetch.owner.wait();
          // Rebinding provenance may advance readiness without changing prepared
          // text/anchors or performing any canonical recipient work.
          expect(preparedPackets()).toEqual(preparedBefore);
          expect(await loadTranscriptEvents(recipient)).toEqual(before);
          expect(loadSessionEntry(recipient)).toEqual(entryBefore);
          expect(recipientUpdates).toBe(0);
          expect(rootUpdates).toBe(rootUpdatesBefore);
          expect(budget.compact).not.toHaveBeenCalled();
          secondOpeningLive = false;
          expect(() => prefetch!.owner.assertCurrent()).toThrow();
          await prefetch.owner.close();
          expect(prefetch.cache.peek(later, 0)).toBeUndefined();
          await publish(chat, chatOwner, "after-close", "This fact has no open recipient.");
          expect(await loadTranscriptEvents(recipient)).toEqual(before);
        } finally {
          stopObservation();
          await prefetch?.owner.close();
          await fixture.close();
        }
      },
    );
  });

  async function consumeWithNativeWriter(
    scenario: "response-close" | "outer-retry",
    { signal }: { signal: AbortSignal },
  ) {
    const foregroundPhase = new AsyncLocalStorage<boolean>();
    const foregroundReads = { root: 0, progress: 0 };
    const readRoot = knowledgeStoreReads.readConversationKnowledgeRoot;
    const readProgress = knowledgePacketReads.readConversationKnowledgePacketProgress;
    // Observe the real owners. Background preparation has detached async custody
    // and may scan; only reads inherited from this foreground refresh are counted.
    const rootRead = vi
      .spyOn(knowledgeStoreReads, "readConversationKnowledgeRoot")
      .mockImplementation((...args) => {
        if (foregroundPhase.getStore()) {
          foregroundReads.root++;
        }
        return readRoot(...args);
      });
    const progressRead = vi
      .spyOn(knowledgePacketReads, "readConversationKnowledgePacketProgress")
      .mockImplementation((...args) => {
        if (foregroundPhase.getStore()) {
          foregroundReads.progress++;
        }
        return readProgress(...args);
      });
    onTestFinished(() => {
      rootRead.mockRestore();
      progressRead.mockRestore();
      foregroundPhase.disable();
    });
    await withOpenClawTestState(
      { scenario: "minimal", label: "knowledge-prefetch-native" },
      async (state) => {
        const fixture = await createConversationKnowledgeScenario(state);
        let stopRootObservation = () => {};
        let prefetch: ReturnType<typeof prepareConversationKnowledgeRecipient>;
        let releaseForeground = () => {};
        try {
          const donor = await fixture.branch("donor");
          const donorOwner = await fixture.claim(donor);
          const recipient = await fixture.branch("recipient");
          releaseForeground = await beginForegroundSessionMaintenance(recipient.sessionKey);
          const target = await resolveAgentRunSessionTarget({
            ...recipient,
            config: fixture.cfg,
            missingSessionKey: "resolve-existing",
          });
          const runId = "prefetch-native-recipient-run";
          const writer = {
            ...target,
            expectedLifecycleRevision: recipient.lifecycleRevision,
            expectedWriterRunId: runId,
          };
          await upsertSessionEntryCore(recipient, {
            ...loadSessionEntry(recipient)!,
            activeWriterRunId: runId,
          });
          const owner = await fixture.claim({ ...recipient, storePath: target.storePath });
          const branch = await readConversationKnowledgeBranch(owner);
          if (!branch) {
            throw new Error("Expected actual native recipient membership");
          }
          let rootPublicationActive = false;
          let rootUpdates = 0;
          stopRootObservation = onInternalSessionTranscriptUpdate((update) => {
            if (
              update.target?.agentId === branch.agentId &&
              update.target.sessionKey === branch.root.sessionKey &&
              update.target.sessionId === branch.root.sessionId &&
              update.target.storePath === branch.storePath
            ) {
              rootUpdates++;
              rootPublicationActive = true;
              queueMicrotask(() => {
                rootPublicationActive = false;
              });
            }
          });
          // Fixture-issued host audience substitutes only for channel ingress.
          // Personal source grants, root evidence, native cohort and writer remain real.
          const audience: ConversationPrivateAudience = {
            agentId: branch.agentId,
            sessionKey: branch.sessionKey,
            channelId: "matrix",
            accountId: "default",
            nativeChannelId: "synthetic-direct-conversation",
            participant: person,
            assertCurrent() {
              expect(rootPublicationActive).toBe(false);
              owner.assertCurrent();
            },
          };
          prefetch = prepareConversationKnowledgeRecipient({
            branch,
            participant: person,
            audience,
            env: state.env,
            getRuntimeConfig: () => fixture.cfg,
          });
          if (!prefetch) {
            throw new Error("Expected actual eligible native prefetch recipient");
          }
          await prefetch.owner.wait();
          const publish = async (id: string, text: string) => {
            const terminal = await fixture.append(donor, id, "stop", text);
            expect(
              await recordConversationKnowledgeTurn({
                ...donorOwner,
                ...terminal,
                privateAudience: { participant: person, admission: terminal.admission! },
              }),
            ).toBe(true);
            await prefetch!.owner.wait();
            const receipt = (await fixture.receipts()).find((value) => value.runId === id)!;
            expect(receipt).toBeDefined();
            return conversationKnowledgeContributionId(receipt);
          };
          const firstId = await publish("first-observation", "The color is yellow.");
          expect(rootUpdates).toBeGreaterThan(0);
          expect(prefetch.cache.peek(firstId, 0)?.part.text).toContain("The color is yellow.");
          const packets = async () =>
            (await loadTranscriptEvents(recipient))
              .map(asOptionalRecord)
              .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT);
          expect(await packets()).toEqual([]);

          const { replyOperation } = createMockReplyOperation({
            key: recipient.sessionKey,
            sessionId: recipient.sessionId,
          });
          lifecycleAdmissionByOperation.set(replyOperation, { reader: owner.reader });
          const followupRun = createMockFollowupRun({
            conversationParticipant: person,
            conversationAudience: audience,
            run: { ...target, config: fixture.cfg },
          });
          const admission = prepareAgentRunAdmission({
            cfg: fixture.cfg,
            operationalRunInstance: createOperationalRunInstanceRef(runId),
            assertSourceCurrent: owner.assertCurrent,
            facts: {
              runId,
              agentId: recipient.agentId,
              ingress: { kind: "channel", boundary: "knowledge-prefetch-test", state: "present" },
            },
          });
          const knowledge = createReplyConversationKnowledgeTurn({
            turn: { isHeartbeat: false, followupRun, replyOperation },
            originalSource: owner.assertCurrent,
            getRuntimeConfig: () => fixture.cfg,
          });
          if (!knowledge) {
            throw new Error("Expected actual native knowledge turn");
          }
          const refreshReady = (request: Parameters<typeof knowledge.refreshPrepared>[0]) =>
            foregroundPhase.run(true, () => knowledge.refreshPrepared(request));
          const logicalTurn = new AbortController();
          try {
            await knowledge.prepare(admission, AbortSignal.any([signal, logicalTurn.signal]));
            const run = {
              ...followupRun.run,
              runId,
              prompt: "Which color?",
              sessionTarget: writer,
              contextTokenBudget: 100_000,
            };
            await withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
              knowledge.prepareHistory(run),
            );
            expect(await packets()).toEqual([]);
            if (scenario === "outer-retry") {
              // The actual native recorder commits one canonical user row. Both
              // fresh attempts read before that same row; packet receipts remain
              // durable even when the first synthetic provider fails afterward.
              const sessionEntry = loadSessionEntry(recipient);
              if (!sessionEntry) {
                throw new Error("Expected the admitted recipient entry for the native recorder");
              }
              const recorder = createUserTurnTranscriptRecorder({
                target: { ...writer, sessionEntry },
                input: { text: "Which color?" },
                assertOriginalInputCommit: owner.assertCurrent,
              });
              await withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
                recorder.persistApproved({ expectedSessionId: recipient.sessionId }),
              );
              const currentInput = recorder.getAdmissionReceipt();
              expect(currentInput).toBeDefined();
              if (!currentInput) {
                throw new Error("Expected real native current-user admission");
              }
              const requests: unknown[] = [];
              const model = makeProviderModelFixture({
                id: "test-model",
                provider: "test-provider",
                api: "openai-responses",
                baseUrl: "https://model.example.test/v1",
              });
              streamMocks.streamSimple.mockImplementation((activeModel, context) => {
                requests.push(structuredClone(context.messages));
                const first = requests.length === 1;
                return createAssistantResultStream({
                  ...createAssistant(
                    activeModel,
                    first ? [] : [{ type: "text", text: "Yellow." }],
                    first ? "error" : "stop",
                  ),
                  ...(first ? { errorMessage: "503 synthetic provider failure" } : {}),
                });
              });
              for (let attemptIndex = 0; attemptIndex < 2; attemptIndex++) {
                const manager = await SessionManager.openModelContextAsync(writer, {
                  admission: currentInput,
                  signal,
                });
                expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain(
                  "The color is yellow.",
                );
                const { session } = await createTestSession({ model, sessionManager: manager });
                await withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
                  submitEmbeddedAttemptPrompt({
                    ...createBaseInput(),
                    attempt: {
                      sessionId: recipient.sessionId,
                      userTurnTranscriptRecorder: recorder,
                    },
                    activeSession: session,
                    contextTokenBudget: 100_000,
                    modelPrompt: "Which color?",
                    transcriptPrompt: "Which color?",
                    prependContext: undefined,
                    appendContext: undefined,
                    assertHostActive: () => admission.assertSourceCurrent(),
                    compactionRequestBudget: createCompactionRequestBudget({
                      contextWindow: 100_000,
                      reserveTokens: 1_024,
                    }),
                    refreshConversationContext: refreshReady,
                    promptActiveSession: (prompt, options) => session.prompt(prompt, options),
                  }),
                );
                expect(await packets()).toHaveLength(1);
              }
              expect(requests).toHaveLength(2);
              expect(JSON.stringify(requests[0])).toContain("The color is yellow.");
              expect(JSON.stringify(requests[1])).toContain("The color is yellow.");
              expect(
                (await loadTranscriptEvents(recipient)).filter(
                  (event) => asOptionalRecord(asOptionalRecord(event)?.message)?.role === "user",
                ),
              ).toHaveLength(1);
              expect(budget.compact).not.toHaveBeenCalled();
              expect(foregroundReads).toEqual({ root: 0, progress: 0 });
              return;
            }
            const refresh = (canAdmit: boolean) =>
              withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
                refreshReady({ signal, canAdmit: () => canAdmit }),
              );
            const stagedBefore = prefetch.cache.peek(firstId, 0);
            expect(stagedBefore).toBeDefined();
            const historyBeforeRefusal = await loadTranscriptEvents(recipient);
            expect(await refresh(false)).toEqual([]);
            await prefetch.owner.wait();
            expect(prefetch.cache.peek(firstId, 0)).toEqual(stagedBefore);
            expect(await loadTranscriptEvents(recipient)).toEqual(historyBeforeRefusal);
            expect(await packets()).toEqual([]);
            expect(budget.compact).not.toHaveBeenCalled();
            const model = makeProviderModelFixture({
              id: "test-model",
              provider: "openai",
              api: "openai-responses",
              baseUrl: "https://model.example.test/v1",
            });
            const response: {
              signal?: AbortSignal;
              packets: Awaited<ReturnType<typeof knowledge.refreshPrepared>>;
            } = { packets: [] };
            const answer = makeAgentAssistantMessage({
              content: [{ type: "text", text: "The color is yellow." }],
            });
            // Keep the actual response-local cancellation owner: successful Core
            // cleanup must not revoke the longer-lived native turn or its grants.
            await streamAgentResponse(
              { systemPrompt: "Synthetic response lifecycle.", messages: [] },
              { model, convertToLlm: () => [] },
              logicalTurn.signal,
              () => {},
              [],
              async () => {
                throw new Error("Unexpected synthetic tool execution");
              },
              (message) => message,
              async (_model, _context, options) => {
                const requestSignal = options?.signal;
                if (!requestSignal) {
                  throw new Error("Expected actual response-local cancellation");
                }
                response.signal = requestSignal;
                response.packets = await withSessionTranscriptWriteAssertion(
                  writer,
                  owner.assertCurrent,
                  () => refreshReady({ signal: requestSignal, canAdmit: () => true }),
                );
                const stream = createAssistantMessageEventStream();
                stream.push({ type: "done", reason: "stop", message: answer });
                stream.end();
                return stream;
              },
            );
            expect(response.signal?.aborted).toBe(true);
            expect(response.signal?.reason).toMatchObject({ message: "Model response closed" });
            expect(() => knowledge.assertCurrent()).not.toThrow();
            admission.assertSourceCurrent();
            const first = response.packets;
            expect(first).toHaveLength(1);
            expect(first[0]?.content).toContain("The color is yellow.");
            expect(await packets()).toHaveLength(1);
            await prefetch.owner.wait();
            expect(prefetch.cache.peek(firstId, 0)).toBeUndefined();

            const terminal = await withSessionTranscriptWriteAssertion(
              writer,
              owner.assertCurrent,
              () =>
                fixture.append({ ...recipient, ...writer }, runId, "stop", "The color is yellow."),
            );
            const route = { provider: model.provider, model: model.id };
            const completed: SettledAgentTurn = {
              kind: "settled",
              status: "ok",
              resolved: route,
              fallback: { exhausted: false, attempts: [] },
              autoCompactionCount: 0,
              didLogHeartbeatStrip: false,
              result: {
                payloads: [{ text: "The color is yellow." }],
                meta: {
                  durationMs: 0,
                  agentMeta: {
                    sessionId: recipient.sessionId,
                    ...route,
                    terminalReceipt: {
                      runId,
                      sessionId: recipient.sessionId,
                      turnId: "prefetch-native-turn",
                      requested: route,
                      effective: { ...route, responseModel: route.model },
                      successfulToolNames: [],
                      rerouted: false,
                      assistantTranscriptIdempotencyKey: terminal.assistantTranscriptIdempotencyKey,
                    },
                  },
                },
              },
            };
            await knowledge.record(completed);
            expect(await refresh(true)).toEqual([]);

            const secondId = await publish("second-observation", "The shape is a triangle.");
            expect(prefetch.cache.peek(secondId, 0)?.part.text).toContain(
              "The shape is a triangle.",
            );
            const second = await refresh(true);
            expect(second).toHaveLength(1);
            expect(second[0]?.content).toContain("The shape is a triangle.");
            expect(second[0]?.content).not.toContain("The color is yellow.");
            expect(await packets()).toHaveLength(2);
            await prefetch.owner.wait();
            expect(prefetch.cache.peek(firstId, 0)).toBeUndefined();
            expect(prefetch.cache.peek(secondId, 0)).toBeUndefined();
            for (let index = 0; index < 10; index++) {
              await publish(`backlog-${index}`, `Observation number ${index} is retained.`);
            }
            const backlog = await refresh(true);
            expect(backlog).toHaveLength(10);
            expect(backlog.at(-1)?.content).toContain("Observation number 9 is retained.");
            expect(await packets()).toHaveLength(12);
            expect(budget.compact).not.toHaveBeenCalled();
            expect(foregroundReads).toEqual({ root: 0, progress: 0 });
            logicalTurn.abort(new Error("Logical turn canceled"));
            expect(() => knowledge.assertCurrent()).toThrow("Logical turn canceled");
          } finally {
            knowledge.release();
            admission.close();
            lifecycleAdmissionByOperation.delete(replyOperation);
          }
        } finally {
          stopRootObservation();
          releaseForeground();
          await prefetch?.owner.close();
          await fixture.close();
        }
      },
    );
  }
  it.for(["response-close", "outer-retry"] as const)(
    "consumes ready packets with the native writer (%s)",
    consumeWithNativeWriter,
  );
});
