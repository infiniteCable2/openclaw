import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { createConversationContextCapacity } from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import {
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { conversationKnowledgeAudienceIdentity } from "../../config/sessions/conversation-audience.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
} from "../../config/sessions/conversation-knowledge-packets.js";
import * as knowledgeStoreReads from "../../config/sessions/conversation-knowledge-store.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { getBackgroundOwnerLane } from "../../process/background-work.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareConversationKnowledgeRecipient } from "./conversation-knowledge-prefetch.js";
import * as knowledgePreparation from "./conversation-knowledge.js";
import {
  createConversationKnowledgeScenario,
  otherPerson,
  person,
} from "./conversation-knowledge.scenario.test-support.js";

const budget = vi.hoisted(() => ({ compact: vi.fn() }));
// mock-isolation: Native idle preparation and retention must never compact a model.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: budget.compact,
}));

registerAgentSessionLoopTestLifecycle();
const { readConversationKnowledgeBranch, recordConversationKnowledgeTurn } = knowledgeStoreReads;
it.each([false, true])(
  "settles idle imports and wakes for a new original (initial neighbors=%s)",
  async (initialNeighbors, context) => {
    const { signal } = context;
    let stage = "setup:state";
    let cleanupStage: string | undefined;
    context.onTestFailed(() => {
      console.error(JSON.stringify({ scenario: "legacy-idle-quiescence", stage, cleanupStage }));
    });
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      let prefetch: ReturnType<typeof prepareConversationKnowledgeRecipient>;
      const preparation = vi.spyOn(knowledgePreparation, "prepareReplyConversationKnowledge");
      const roots = vi.spyOn(knowledgeStoreReads, "readConversationKnowledgeRoot");
      onTestFinished(() => {
        preparation.mockRestore();
        roots.mockRestore();
      });
      budget.compact.mockClear();
      try {
        stage = "setup:config";
        fixture.cfg.agents!.defaults = { model: { primary: "synthetic/legacy-budget" } };
        fixture.cfg.models = {
          providers: {
            synthetic: {
              baseUrl: "https://model.example.invalid",
              api: "openai-completions",
              apiKey: "synthetic-unused-key",
              models: [
                {
                  id: "legacy-budget",
                  name: "Synthetic idle budget",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_000_000,
                  maxTokens: 16_384,
                },
              ],
            },
          },
        };
        await state.writeConfig(fixture.cfg);
        const valid = await fixture.branch("valid-legacy-neighbor");
        // A missing saved audience alone is not denial: a current same-person
        // native roster can authorize ordinary history. This old source has neither.
        const legacy = await fixture.branch("unconfirmed-legacy", null);
        const unlinked = await fixture.branch("unlinked-legacy", otherPerson);
        const owners = new Map(
          await Promise.all(
            [valid, legacy, unlinked].map(
              async (source) => [source, await fixture.claim(source)] as const,
            ),
          ),
        );
        const legacyOwner = owners.get(legacy)!;
        await legacyOwner.reader.withRead(
          { sessionKeys: [legacy.sessionKey] },
          legacyOwner.assertCurrent,
          (facts) => {
            const entry = facts.entries.find((row) => row.sessionKey === legacy.sessionKey)?.entry;
            expect(entry).toBeDefined();
            expect(conversationKnowledgeAudienceIdentity(entry ?? {})).toBeUndefined();
          },
        );
        const publish = async (source: typeof valid, id: string) => {
          const terminal = await fixture.append(source, id);
          expect(
            await recordConversationKnowledgeTurn({
              ...owners.get(source)!,
              ...terminal,
              ...(source === legacy
                ? {}
                : {
                    privateAudience: {
                      participant: source === unlinked ? otherPerson : person,
                      admission: terminal.admission!,
                    },
                  }),
            }),
          ).toBe(true);
          const reference = (await fixture.receipts()).find((value) => value.runId === id);
          if (!reference) {
            throw new Error("Expected actual published original");
          }
          return conversationKnowledgeContributionId(reference);
        };
        stage = "setup:originals";
        const expected = initialNeighbors ? [await publish(valid, "first-valid")] : [];
        for (let index = 0; index < 17; index++) {
          await publish(legacy, `unaudienced-${index}`);
        }
        for (let index = 0; index < 3; index++) {
          await publish(unlinked, `unlinked-${index}`);
        }
        if (initialNeighbors) {
          expected.push(await publish(valid, "valid-after-three-pages"));
        }
        stage = "setup:recipient";
        const target = await fixture.branch("legacy-idle-recipient");
        await replaceTranscriptEvents(target, [
          { type: "session", id: target.sessionId, version: CURRENT_SESSION_VERSION },
        ]);
        const claim = await fixture.claim(target);
        const branch = await readConversationKnowledgeBranch(claim);
        if (!branch) {
          throw new Error("Expected native idle recipient membership");
        }
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        prefetch = prepareConversationKnowledgeRecipient({
          branch,
          participant: person,
          audience: {
            agentId: branch.agentId,
            sessionKey: branch.sessionKey,
            channelId: "matrix",
            accountId: "default",
            nativeChannelId: "synthetic-legacy-idle",
            participant: person,
            assertCurrent: claim.assertCurrent,
          },
          env: state.env,
          getRuntimeConfig: () => fixture.cfg,
        });
        if (!prefetch) {
          throw new Error("Expected native idle preparation owner");
        }
        prefetch.retainContextBudget(
          createConversationContextCapacity({
            messages: [],
            contextWindow: 1_000_000,
            reserveTokens: 16_384,
          }),
          { provider: "synthetic", model: "legacy-budget", config: fixture.cfg },
        );
        // Join the existing root lane before the recipient: no model/input turn
        // or timing poll may be needed to make an already open recipient current.
        const rootLane = getBackgroundOwnerLane("conversation-knowledge-checkpoints");
        const settle = async (label: string) => {
          stage = `${label}:recipient-before-root`;
          await withinTest(prefetch!.owner.wait(), signal);
          stage = `${label}:root-barrier`;
          await withinTest(
            enqueueCommandInLane(rootLane, async () => {}, { abortSignal: signal }),
            signal,
          );
          stage = `${label}:recipient-after-root`;
          await withinTest(prefetch!.owner.wait(), signal);
          stage = `${label}:settled`;
        };
        const packets = async () =>
          (await loadTranscriptEvents(target)).flatMap((event) => {
            const row = asOptionalRecord(event);
            return row?.customType === CONVERSATION_KNOWLEDGE_CONTEXT
              ? [asOptionalRecord(row.details)?.contributionId]
              : [];
          });
        const counters = () => [
          preparation.mock.calls.length,
          roots.mock.calls.length,
          prefetch!.cache.revision,
          prefetch!.cache.consumptionRevision,
        ];
        await settle("initial");
        expect(await packets()).toEqual(expected);
        expect(prefetch.cache.preparedPackets(1)).toEqual([]);
        const quiet = counters();
        // Exercise the existing retry clock once, rather than sleeping/polling.
        stage = "quiet:retry-clock";
        await vi.advanceTimersByTimeAsync(60_000);
        await settle("quiet");
        expect(counters()).toEqual(quiet);
        stage = "publish:later-original";
        expected.push(await publish(valid, "later-valid-original"));
        await settle("later");
        expect(await packets()).toEqual(expected);
        expect(preparation.mock.calls.length).toBeGreaterThan(quiet[0]!);
        expect(budget.compact).not.toHaveBeenCalled();
        expect(streamMocks.streamSimple).not.toHaveBeenCalled();
      } finally {
        // Restore the real clock before joining asynchronous native cleanup;
        // the assertion clock must not strand a worker or mask the original failure.
        vi.useRealTimers();
        try {
          cleanupStage = "recipient";
          await prefetch?.owner.close();
        } finally {
          cleanupStage = "fixture";
          await fixture.close();
          cleanupStage = "complete";
        }
      }
    });
  },
);
