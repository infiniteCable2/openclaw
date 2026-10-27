import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "../../agents/embedded-agent-runner/compact.types.js";
import { CONVERSATION_KNOWLEDGE_CONTEXT } from "../../config/sessions/conversation-knowledge-packets.js";
import {
  readConversationKnowledgeBranch,
  recordConversationKnowledgeTurn,
} from "../../config/sessions/conversation-knowledge-store.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runIdleConversationKnowledge } from "./conversation-knowledge-idle.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";

const budget = vi.hoisted(() => ({
  compact: vi.fn(async (_params: CompactEmbeddedAgentSessionRuntimeParams) => ({
    ok: true,
    compacted: false,
    reason: "within native budget",
  })),
}));
// mock-isolation: Avoid model inference; real SQLite, workers, source grants, packet progress and native idle scheduling remain active.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: budget.compact,
}));

it("finishes a multi-quantum source before settling later sources, without another user turn", async ({
  signal,
}) => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "knowledge-idle-multi-source-backlog" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        const chat = await fixture.branch("long-chat");
        const priorCall = await fixture.branch("prior-call");
        const recipient = await fixture.branch("new-call");
        // More than the 32-packet idle quantum at the production 4,000-character
        // packet size. A second contribution exposes a skipped remainder that
        // a single-source fixture revisits accidentally from offset zero.
        const firstText = `${"Earlier synthetic chat observation. ".repeat(5_000)}CHAT_TAIL_AMBER`;
        const secondText = "The previous call codeword is violet. CALL_TAIL_VIOLET";
        for (const [source, runId, text] of [
          [chat, "long-chat-run", firstText],
          [priorCall, "prior-call-run", secondText],
        ] as const) {
          const sourceOwner = await fixture.claim(source);
          const terminal = await fixture.append(source, runId, "stop", text);
          expect(
            await recordConversationKnowledgeTurn({
              ...sourceOwner,
              ...terminal,
              privateAudience: { participant: person, admission: terminal.admission! },
            }),
          ).toBe(true);
        }
        const claim = await fixture.claim(recipient);
        const branch = await readConversationKnowledgeBranch(claim);
        if (!branch) {
          throw new Error("Expected real native recipient branch membership");
        }
        const audience: ConversationPrivateAudience = {
          agentId: recipient.agentId,
          sessionKey: recipient.sessionKey,
          channelId: "matrix",
          accountId: "default",
          nativeChannelId: "synthetic-private-next-call",
          participant: person,
          assertCurrent: claim.assertCurrent,
        };
        const request = {
          branch,
          participant: person,
          audience,
          env: state.env,
          getRuntimeConfig: () => fixture.cfg,
          signal,
        };
        const result = await runIdleConversationKnowledge(request);
        expect(result.status).toBe("settled");
        const packets = (await loadTranscriptEvents(recipient))
          .map(asOptionalRecord)
          .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT);
        const text = packets.map((event) => event!.content).join("\n");
        expect(text).toContain("CHAT_TAIL_AMBER");
        expect(text).toContain("CALL_TAIL_VIOLET");
        expect(text.indexOf("CHAT_TAIL_AMBER")).toBeLessThan(text.indexOf("CALL_TAIL_VIOLET"));
        expect(
          new Set(packets.map((event) => asOptionalRecord(event!.details)?.packetId)).size,
        ).toBe(packets.length);
        expect(result.admittedPackets).toBe(packets.length);

        // Reopening an unchanged idle recipient must preserve its imported history
        // without repeating model-context preparation just to rediscover no work.
        const maintenanceCalls = budget.compact.mock.calls.length;
        await expect(runIdleConversationKnowledge(request)).resolves.toEqual({
          status: "settled",
          admittedPackets: 0,
        });
        expect(budget.compact).toHaveBeenCalledTimes(maintenanceCalls);
      } finally {
        await fixture.close();
      }
    },
  );
});
