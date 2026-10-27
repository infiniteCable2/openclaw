import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createConversationContextCapacity } from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
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
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as reportStorage from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareConversationKnowledgeRecipient } from "./conversation-knowledge-prefetch.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";

const budget = vi.hoisted(() => ({ compact: vi.fn() }));
// mock-isolation: Model compaction is forbidden here; actual SQLite, source authorization,
// read-ahead, native request capacity and admitted-writer packet commits remain real.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: budget.compact,
}));

const simulation = process.env.OPENCLAW_TEST_KNOWLEDGE_SIMULATION === "1";
function simulationInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (
    !simulation ||
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`Invalid opt-in knowledge simulation setting: ${name}`);
  }
  return value;
}
const contributionCount = simulationInteger("OPENCLAW_TEST_KNOWLEDGE_CONTRIBUTIONS", 4, 1, 64);
const historyEvents = simulationInteger("OPENCLAW_TEST_KNOWLEDGE_HISTORY_EVENTS", 40, 0, 5_000);
const observationRepeat = simulationInteger(
  "OPENCLAW_TEST_KNOWLEDGE_OBSERVATION_REPEAT",
  8,
  1,
  12_000,
);

it("prepares long-source observations while idle and consumes them once through the admitted writer", async ({
  signal,
}) => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "knowledge-recipient-throughput" },
    async (state) => {
      const setupStarted = performance.now();
      const fixture = await createConversationKnowledgeScenario(state);
      const batch = vi.spyOn(reportStorage, "appendSessionTranscriptReportBatch");
      let prefetch: ReturnType<typeof prepareConversationKnowledgeRecipient>;
      budget.compact.mockClear();
      try {
        const chat = await fixture.branch("throughput-chat");
        const previousCall = await fixture.branch("throughput-prior-call");
        const recipient = await fixture.branch("throughput-recipient");
        await replaceTranscriptEvents(chat, [
          { type: "session", id: chat.sessionId, version: CURRENT_SESSION_VERSION },
          ...Array.from({ length: historyEvents }, (_, index) => ({
            type: "message",
            id: `archive-${index}`,
            parentId: index === 0 ? null : `archive-${index - 1}`,
            message: {
              role: "user",
              content: `ARCHIVE_ONLY_${index}: unrelated synthetic historical content.`,
            },
          })),
        ]);
        const chatClaim = await fixture.claim(chat);
        const previousCallClaim = await fixture.claim(previousCall);
        const markers = Array.from(
          { length: contributionCount },
          (_, index) => `CHAT_MARKER_${String(index).padStart(2, "0")}`,
        );
        for (const [index, marker] of markers.entries()) {
          const terminal = await fixture.append(
            chat,
            `throughput-chat-${index}`,
            "stop",
            index === 0
              ? `${"A synthetic earlier observation. ".repeat(observationRepeat)}${marker}.`
              : `A distinct current observation: ${marker}.`,
          );
          expect(
            await recordConversationKnowledgeTurn({
              ...chatClaim,
              ...terminal,
              privateAudience: { participant: person, admission: terminal.admission! },
            }),
          ).toBe(true);
        }
        const callMarker = "PRIOR_CALL_MARKER_VIOLET";
        const previousTerminal = await fixture.append(
          previousCall,
          "throughput-prior-call",
          "stop",
          `An observation from another source: ${callMarker}.`,
        );
        expect(
          await recordConversationKnowledgeTurn({
            ...previousCallClaim,
            ...previousTerminal,
            privateAudience: { participant: person, admission: previousTerminal.admission! },
          }),
        ).toBe(true);
        const target = await resolveAgentRunSessionTarget({
          ...recipient,
          config: fixture.cfg,
          missingSessionKey: "resolve-existing",
        });
        const writer = {
          ...target,
          expectedLifecycleRevision: recipient.lifecycleRevision,
          expectedWriterRunId: "synthetic-throughput-run",
        };
        await upsertSessionEntryCore(recipient, {
          ...loadSessionEntry(recipient)!,
          activeWriterRunId: writer.expectedWriterRunId,
        });
        const recipientClaim = await fixture.claim({ ...recipient, storePath: target.storePath });
        const branch = await readConversationKnowledgeBranch(recipientClaim);
        if (!branch) {
          throw new Error("Synthetic recipient requires actual native branch membership");
        }
        const audience: ConversationPrivateAudience = {
          agentId: recipient.agentId,
          sessionKey: recipient.sessionKey,
          channelId: "matrix",
          accountId: "default",
          nativeChannelId: "synthetic-private-throughput",
          participant: person,
          assertCurrent: recipientClaim.assertCurrent,
        };
        const setupMs = performance.now() - setupStarted;
        const rssBefore = process.memoryUsage().rss;
        const started = performance.now();
        const before = await loadTranscriptEvents(recipient);
        prefetch = prepareConversationKnowledgeRecipient({
          branch,
          participant: person,
          audience,
          env: state.env,
          getRuntimeConfig: () => fixture.cfg,
        });
        if (!prefetch) {
          throw new Error("Expected native prepared recipient");
        }
        await prefetch.owner.wait();
        const preparationMs = performance.now() - started;
        expect(await loadTranscriptEvents(recipient)).toEqual(before);
        expect(budget.compact).not.toHaveBeenCalled();
        batch.mockClear();
        const admit = () =>
          withSessionTranscriptWriteAssertion(writer, recipientClaim.assertCurrent, async () => {
            const canAdmit = createConversationContextCapacity({
              messages: [],
              contextWindow: 1_000_000,
              reserveTokens: 16_384,
            });
            const prepared = await prepareReplyConversationKnowledge({
              ...recipientClaim,
              originalParticipant: person,
              destinationAudience: audience,
              getRuntimeConfig: () => fixture.cfg,
              signal,
              readyOnly: true,
              sourceCache: prefetch!.cache,
              canAdmitPacket: canAdmit,
              retainInHistory: {
                writeTarget: writer,
                // Every packet was reserved by the existing request's native capacity
                // above. Ready consumption never opens a model/compaction runtime.
                maintainContext: async () => ({
                  compacted: false,
                  complete: true,
                  canAdmitPending: true,
                }),
              },
            });
            prepared?.release();
          });
        const admissionStarted = performance.now();
        await admit();
        const admissionMs = performance.now() - admissionStarted;
        const packets = (await loadTranscriptEvents(recipient))
          .map(asOptionalRecord)
          .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT);
        expect(packets.length).toBeGreaterThanOrEqual(markers.length + 1);
        const receipts = await fixture.receipts();
        expect(
          new Set(packets.map((packet) => asOptionalRecord(packet!.details)?.contributionId)),
        ).toEqual(new Set(receipts.map(conversationKnowledgeContributionId)));
        const text = packets.map((packet) => packet!.content).join("\n");
        let previousPosition = -1;
        for (const marker of [...markers, callMarker]) {
          const position = text.indexOf(marker);
          expect(position).toBeGreaterThan(previousPosition);
          previousPosition = position;
        }
        expect(text).not.toContain("ARCHIVE_ONLY_");
        expect(
          new Set(packets.map((packet) => asOptionalRecord(packet!.details)?.packetId)).size,
        ).toBe(packets.length);
        const batchCalls = batch.mock.calls.length;
        expect(batchCalls).toBeGreaterThan(0);
        expect(
          batch.mock.calls.every(([, entries]) => entries.length > 0 && entries.length <= 32),
        ).toBe(true);
        if (simulation) {
          console.info(
            JSON.stringify({
              benchmark: "recipient-readiness-and-native-consumption",
              historyEvents,
              contributions: markers.length + 1,
              packets: packets.length,
              sources: 2,
              observationRepeat,
              nativeBatchCalls: batchCalls,
              compactionCalls: budget.compact.mock.calls.length,
              setupMs,
              preparationMs,
              admissionMs,
              harnessRssBefore: rssBefore,
              harnessRssAfter: process.memoryUsage().rss,
              processLifetimePeakRssKiB: process.resourceUsage().maxRSS,
              mocked: "model compaction module, expected never called",
              real: "SQLite, compiled workers, source authority, bounded read-ahead, native request capacity, exact packet receipts and admitted writer",
              serverLatencyAcceptance: false,
            }),
          );
        }
        await admit();
        expect(batch).toHaveBeenCalledTimes(batchCalls);
        expect(budget.compact).not.toHaveBeenCalled();
        expect(await fixture.receipts()).toEqual(receipts);
        expect(
          (await loadTranscriptEvents(recipient))
            .map(asOptionalRecord)
            .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT),
        ).toHaveLength(packets.length);
      } finally {
        batch.mockRestore();
        await prefetch?.owner.close();
        await fixture.close();
      }
    },
  );
});
