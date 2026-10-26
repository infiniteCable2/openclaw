import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { streamAgentResponse } from "../../../packages/agent-core/src/agent-stream-response.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
} from "../../config/sessions/conversation-knowledge-packets.js";
import {
  readConversationKnowledgeBranch,
  recordConversationKnowledgeTurn,
} from "../../config/sessions/conversation-knowledge-store.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
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

describe("native branch prefetch and model-boundary composition", () => {
  it("warms on committed roots and consumes only ready packets under the existing native writer", async ({
    signal,
  }) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "knowledge-prefetch-native" },
      async (state) => {
        const fixture = await createConversationKnowledgeScenario(state);
        let stopRootObservation = () => {};
        let prefetch: ReturnType<typeof prepareConversationKnowledgeRecipient>;
        try {
          const donor = await fixture.branch("donor");
          const donorOwner = await fixture.claim(donor);
          const recipient = await fixture.branch("recipient");
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
            const refresh = (canAdmit: boolean) =>
              withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
                knowledge.refreshPrepared({ signal, canAdmit: () => canAdmit }),
              );
            const revision = prefetch.cache.revision;
            expect(await refresh(false)).toEqual([]);
            expect(prefetch.cache.revision).toBe(revision);
            expect(await packets()).toEqual([]);
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
                  () => knowledge.refreshPrepared({ signal: requestSignal, canAdmit: () => true }),
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
            expect(budget.compact).not.toHaveBeenCalled();
            logicalTurn.abort(new Error("Logical turn canceled"));
            expect(() => knowledge.assertCurrent()).toThrow("Logical turn canceled");
          } finally {
            knowledge.release();
            admission.close();
            lifecycleAdmissionByOperation.delete(replyOperation);
          }
        } finally {
          stopRootObservation();
          await prefetch?.owner.close();
          await fixture.close();
        }
      },
    );
  });
});
