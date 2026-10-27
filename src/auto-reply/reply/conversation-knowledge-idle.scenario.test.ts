import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "../../agents/embedded-agent-runner/compact.types.js";
import { CONVERSATION_KNOWLEDGE_CONTEXT } from "../../config/sessions/conversation-knowledge-packets.js";
import {
  readConversationKnowledgeBranch,
  recordConversationKnowledgeTurn,
} from "../../config/sessions/conversation-knowledge-store.js";
import { loadSessionEntry, loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptModelContextAsync } from "../../config/sessions/session-transcript-context-read.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runIdleConversationKnowledge } from "./conversation-knowledge-idle.js";
import { openConversationKnowledgeRecipient } from "./conversation-knowledge-open.js";
import { prepareConversationKnowledgeRecipient } from "./conversation-knowledge-prefetch.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";

const budget = vi.hoisted(() => ({
  compact: vi.fn(async (params: CompactEmbeddedAgentSessionRuntimeParams) => {
    params.budgetPreflight?.onDecision?.(true);
    return { ok: true, compacted: false, reason: "within native budget" };
  }),
}));
// mock-isolation: Replace only model/summary inference; native cohort, private read grants, writer and packet commits remain real.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: budget.compact,
}));

it("hydrates an idle branch from old chat history and both fresh peer sources without any user turn", async ({
  signal,
}) => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "knowledge-idle-native" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      let stopObservation = () => {};
      let closeRecipient = async () => {};
      let observation = Promise.resolve();
      let observationError: Error | undefined;
      try {
        const chat = await fixture.branch("chat");
        const priorCall = await fixture.branch("previous-call");
        const recipient = await fixture.branch("new-call");
        const chatOwner = await fixture.claim(chat);
        const callOwner = await fixture.claim(priorCall);
        const publish = async (
          branch: typeof chat,
          source: typeof chatOwner,
          id: string,
          text: string,
        ) => {
          const terminal = await fixture.append(branch, id, "stop", text);
          expect(
            await recordConversationKnowledgeTurn({
              ...source,
              ...terminal,
              privateAudience: { participant: person, admission: terminal.admission! },
            }),
          ).toBe(true);
        };
        for (let index = 0; index < 9; index++) {
          await publish(chat, chatOwner, `old-chat-${index}`, `Earlier chat fact ${index}.`);
        }
        await publish(chat, chatOwner, "fresh-chat", "The chat codeword is amber.");
        await publish(
          priorCall,
          callOwner,
          "fresh-prior-call",
          "The previous call codeword is violet.",
        );
        let firstOpeningLive = true;
        let secondOpeningLive = true;
        const audience: ConversationPrivateAudience = {
          agentId: recipient.agentId,
          sessionKey: recipient.sessionKey,
          channelId: "matrix",
          accountId: "default",
          nativeChannelId: "synthetic-private-next-call",
          participant: person,
          assertCurrent() {
            if (!firstOpeningLive) {
              throw new Error("First original opening closed");
            }
          },
        };
        const before = loadSessionEntry(recipient)!;
        const recipientClaim = await fixture.claim(recipient);
        const branch = await readConversationKnowledgeBranch(recipientClaim);
        if (!branch) {
          throw new Error("Expected native recipient branch membership");
        }
        const request = {
          branch,
          participant: person,
          audience,
          env: state.env,
          getRuntimeConfig: () => fixture.cfg,
          signal,
        };
        const initialAdmission = createDeferredCore();
        const laterAdmission = createDeferredCore();
        stopObservation = onInternalSessionTranscriptUpdate((update) => {
          if (
            update.target?.agentId === recipient.agentId &&
            update.target.sessionId === recipient.sessionId &&
            update.target.sessionKey === recipient.sessionKey
          ) {
            // A native batch commit emits one notification for several packets.
            // Gate on persisted occurrences, not notification frequency.
            observation = observation
              .then(() =>
                runInDetachedAsyncContext(async () => {
                  const committedPackets = (await loadTranscriptEvents(recipient)).filter(
                    (event) =>
                      asOptionalRecord(event)?.customType === CONVERSATION_KNOWLEDGE_CONTEXT,
                  ).length;
                  if (committedPackets >= 11) {
                    initialAdmission.resolve();
                  }
                  if (committedPackets >= 12) {
                    laterAdmission.resolve();
                  }
                }),
              )
              .catch((error: unknown) => {
                observationError =
                  error instanceof Error
                    ? error
                    : new Error("Committed packet observation failed", { cause: error });
                initialAdmission.resolve();
                laterAdmission.resolve();
              });
          }
        });
        await openConversationKnowledgeRecipient({ ...request, target: recipient });
        // Obtain cleanup custody only after the event-gated behavior proofs. Calling
        // prepare here would itself request work and hide a broken automatic opener.
        closeRecipient = async () => {
          await prepareConversationKnowledgeRecipient(request)?.owner.close();
        };
        await withinTest(initialAdmission.promise, signal);
        if (observationError) {
          throw observationError;
        }
        const packets = async () =>
          (await loadTranscriptEvents(recipient))
            .map(asOptionalRecord)
            .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT);
        const first = await packets();
        expect(first).toHaveLength(11);
        const text = first.map((event) => event!.content).join("\n");
        expect(text).toContain("Earlier chat fact 0.");
        expect(text).toContain("The chat codeword is amber.");
        expect(text).toContain("The previous call codeword is violet.");
        expect(new Set(first.map((event) => asOptionalRecord(event!.details)?.packetId)).size).toBe(
          11,
        );
        const secondAudience: ConversationPrivateAudience = {
          ...audience,
          assertCurrent() {
            if (!secondOpeningLive) {
              throw new Error("Second original opening closed");
            }
          },
        };
        await openConversationKnowledgeRecipient({
          ...request,
          target: recipient,
          audience: secondAudience,
        });
        firstOpeningLive = false;
        closeRecipient = async () => {
          await prepareConversationKnowledgeRecipient({
            ...request,
            audience: secondAudience,
          })?.owner.close();
        };
        await publish(chat, chatOwner, "after-opening", "The later chat codeword is emerald.");
        // No recipient/user request: the committed-root notification alone must hydrate it.
        await withinTest(laterAdmission.promise, signal);
        if (observationError) {
          throw observationError;
        }
        const nativeContext = await readSessionTranscriptModelContextAsync(
          recipient,
          (context) => JSON.stringify(context.events),
          undefined,
          signal,
        );
        expect(nativeContext).toContain("The chat codeword is amber.");
        expect(nativeContext).toContain("The previous call codeword is violet.");
        expect(nativeContext).toContain("The later chat codeword is emerald.");
        await expect(
          runIdleConversationKnowledge({ ...request, audience: secondAudience }),
        ).resolves.toEqual({
          status: "settled",
          admittedPackets: 0,
        });
        expect(await packets()).toHaveLength(12);
        const after = loadSessionEntry(recipient)!;
        expect(after.activeWriterRunId).toBe(before.activeWriterRunId);
        expect(after.sessionId).toBe(before.sessionId);
        expect(after.lifecycleRevision).toBe(before.lifecycleRevision);
        expect(budget.compact).toHaveBeenCalled();
        expect(budget.compact.mock.calls.every(([call]) => call.trigger === "budget")).toBe(true);
        const registration = prepareConversationKnowledgeRecipient({
          ...request,
          audience: secondAudience,
        });
        expect(registration).toBeDefined();
        closeRecipient = async () => {
          await registration!.owner.close();
        };
        secondOpeningLive = false;
        expect(() => registration!.owner.assertCurrent()).toThrow();
        await registration!.owner.close();
        await publish(chat, chatOwner, "after-all-close", "This fact has no open recipient.");
        expect(await packets()).toHaveLength(12);
      } finally {
        stopObservation();
        try {
          await observation;
          await closeRecipient();
        } finally {
          await fixture.close();
        }
      }
    },
  );
});
