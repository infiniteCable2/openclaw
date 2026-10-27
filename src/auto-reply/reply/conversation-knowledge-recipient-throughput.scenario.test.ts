import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "../../agents/embedded-agent-runner/compact.types.js";
import { CONVERSATION_KNOWLEDGE_CONTEXT } from "../../config/sessions/conversation-knowledge-packets.js";
import {
  readConversationKnowledgeBranch,
  recordConversationKnowledgeTurn,
} from "../../config/sessions/conversation-knowledge-store.js";
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import * as reportStorage from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runIdleConversationKnowledge } from "./conversation-knowledge-idle.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";

const budget = vi.hoisted(() => ({
  compact: vi.fn(async (params: CompactEmbeddedAgentSessionRuntimeParams) => {
    params.budgetPreflight?.onDecision?.(true);
    return { ok: true, compacted: false, reason: "synthetic observations fit native budget" };
  }),
}));
// mock-isolation: Exclude native model/prompt preparation and summary inference, explicitly returning fit. Actual SQLite, workers, personal read grants, source projections, recipient scheduling and batch publication remain real.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: budget.compact,
}));

it("imports many authorized small contributions after a long source prefix through bounded native batches", async ({
  signal,
}) => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "knowledge-recipient-throughput" },
    async (state) => {
      const setupStarted = performance.now();
      const fixture = await createConversationKnowledgeScenario(state);
      const batch = vi.spyOn(reportStorage, "appendSessionTranscriptReportBatch");
      budget.compact.mockClear();
      try {
        const chat = await fixture.branch("throughput-chat");
        const previousCall = await fixture.branch("throughput-prior-call");
        const recipient = await fixture.branch("throughput-recipient");
        const historyEvents = 600;
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
          { length: 12 },
          (_, index) => `CHAT_MARKER_${String(index).padStart(2, "0")}`,
        );
        for (const [index, marker] of markers.entries()) {
          const terminal = await fixture.append(
            chat,
            `throughput-chat-${index}`,
            "stop",
            `A distinct current observation: ${marker}.`,
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
        const recipientClaim = await fixture.claim(recipient);
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
        const request = {
          branch,
          participant: person,
          audience,
          env: state.env,
          getRuntimeConfig: () => fixture.cfg,
          signal,
        };
        const setupMs = performance.now() - setupStarted;
        batch.mockClear();
        const rssBefore = process.memoryUsage().rss;
        const started = performance.now();
        const result = await runIdleConversationKnowledge(request);
        const elapsedMs = performance.now() - started;
        expect(result.status).toBe("settled");
        const packets = (await loadTranscriptEvents(recipient))
          .map(asOptionalRecord)
          .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT);
        expect(packets).toHaveLength(markers.length + 1);
        expect(result.admittedPackets).toBe(packets.length);
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
        expect(batchCalls).toBeLessThan(packets.length);
        expect(
          batch.mock.calls.every(([, entries]) => entries.length > 0 && entries.length <= 32),
        ).toBe(true);
        const budgetCalls = budget.compact.mock.calls.length;
        console.info(
          JSON.stringify({
            benchmark: "recipient-native-storage-throughput",
            historyEvents,
            contributions: packets.length,
            sources: 2,
            nativeBatchCalls: batchCalls,
            budgetCalls,
            setupMs,
            admissionMs: elapsedMs,
            harnessRssBefore: rssBefore,
            harnessRssAfter: process.memoryUsage().rss,
            mocked:
              "native model/prompt preparation and summary inference; positive prospective budget decision",
            real: "SQLite, compiled workers, source authority and projections, idle owner, exact packet receipts and batch commits",
            serverLatencyAcceptance: false,
          }),
        );
        await expect(runIdleConversationKnowledge(request)).resolves.toEqual({
          status: "settled",
          admittedPackets: 0,
        });
        expect(batch).toHaveBeenCalledTimes(batchCalls);
        expect(budget.compact).toHaveBeenCalledTimes(budgetCalls);
        expect(
          (await loadTranscriptEvents(recipient))
            .map(asOptionalRecord)
            .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT),
        ).toHaveLength(packets.length);
      } finally {
        batch.mockRestore();
        await fixture.close();
      }
    },
  );
});
