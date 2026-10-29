import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  createConversationKnowledgeScenario,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { preparePersonalConversationRead } from "../../gateway/session-transcript-personal-read.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
  conversationKnowledgePacketId,
  retainConversationKnowledgePackets,
  type ConversationKnowledgePacketAdmission,
} from "./conversation-knowledge-packets.js";
import {
  readConversationKnowledgeBranch,
  readConversationKnowledgeRoot,
  recordConversationKnowledgeTurn,
} from "./conversation-knowledge-store.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import { readSessionTranscriptModelContextAsync } from "./session-transcript-context-read.js";
import { withSessionTranscriptWriteAssertion } from "./transcript-write-context.js";

describe("native historical contribution packet custody", () => {
  it.each(["retain", "fabricated", "mismatch", "released", "commit-race"] as const)(
    "%s uses original provenance and independently current custody after a real same-ID reset",
    async (mode) => {
      await withOpenClawTestState(
        { scenario: "minimal", label: `historical-packet-${mode}` },
        async (state) => {
          const f = await createConversationKnowledgeScenario(state);
          let grant: Awaited<ReturnType<typeof preparePersonalConversationRead>> | undefined;
          try {
            const donor = await f.branch("historical-donor");
            const recipient = await f.branch("historical-recipient");
            const terminal = await f.append(
              donor,
              "original-run",
              "stop",
              "Original private fact.",
            );
            const donorClaim = await f.claim(donor);
            expect(
              await recordConversationKnowledgeTurn({
                ...donorClaim,
                ...terminal,
                privateAudience: { participant: person, admission: terminal.admission! },
              }),
            ).toBe(true);
            const [receipt] = await f.receipts();
            if (!receipt) throw new Error("Expected exact original root reference");
            const originalReceipt = structuredClone(receipt);
            const before = loadSessionEntry(donor)!;
            await resetSessionEntryLifecycle({
              agentId: donor.agentId,
              storePath: donor.storePath,
              target: { canonicalKey: donor.sessionKey, storeKeys: [donor.sessionKey] },
              resetBoundary: { context: "clear", reason: "reset", cwd: state.workspaceDir },
              buildNextEntry: () => ({ ...before, lifecycleRevision: "after-reset" }),
            });
            expect(loadSessionEntry(donor)?.sessionId).toBe(donor.sessionId);
            // A real user append supplies the native recipient header and active context.
            await appendTranscriptMessage(recipient, {
              message: { role: "user", content: "Recall the private fact.", timestamp: Date.now() },
            });
            const runId = "historical-packet-writer";
            await upsertSessionEntryCore(recipient, {
              ...loadSessionEntry(recipient)!,
              activeWriterRunId: runId,
            });
            const target = await f.claim(recipient);
            const branch = await readConversationKnowledgeBranch(target);
            if (!branch) throw new Error("Expected native recipient branch");
            const root = await readConversationKnowledgeRoot({ ...target, branch });
            grant = await preparePersonalConversationRead({
              purpose: "conversation-differences",
              personal: {
                originalParticipant: person,
                assertCurrent: target.assertCurrent,
                target: branch,
                contribution: receipt,
                rootEvidence: root.evidence,
              },
              getRuntimeConfig: () => f.cfg,
              sources: [receipt.source],
            });
            const proof = grant.selectContribution(receipt);
            if (!proof) throw new Error("Expected native exact historical range proof");
            expect(proof.originalLifecycleRevision).toBe(donor.lifecycleRevision);
            expect(proof.currentLifecycleRevision).toBe("after-reset");
            const projection = await readSessionTranscriptModelContextAsync(
              donor,
              (context) => context,
              undefined,
              undefined,
              proof.through,
              { from: proof.from, maxBytes: 64 * 1024, maxEvents: 64 },
            );
            if (!projection.version) throw new Error("Expected native historical prefix version");
            const writer = {
              ...branch,
              expectedLifecycleRevision: branch.lifecycleRevision,
              expectedWriterRunId: runId,
            };
            const packet: ConversationKnowledgePacketAdmission = {
              receipt,
              text: JSON.stringify({
                source: receipt.origin,
                sourceSessionKey: receipt.source.sessionKey,
                throughEntryId: receipt.through.entryId,
                observations: [{ speaker: "assistant", text: "Original private fact." }],
              }),
              offset: 0,
              nextOffset: 1,
              complete: true,
              sourceVersion: projection.version,
              // The proof itself must contribute the live native COMMIT predicates.
              source: target.assertCurrent,
              historicalCustody: proof,
            };
            if (mode === "fabricated") packet.historicalCustody = { ...proof };
            if (mode === "mismatch") {
              packet.receipt = { ...receipt, runId: "different-original-run" };
            }
            if (mode === "released") grant.release();
            if (mode === "commit-race") {
              packet.source = Object.assign(() => target.assertCurrent(), {
                prepareSessionSource: async () => {
                  await upsertSessionEntryCore(donor, {
                    ...loadSessionEntry(donor)!,
                    lifecycleRevision: "racing-reset",
                  });
                  return { assertCurrent: target.assertCurrent, checks: [] };
                },
              }) satisfies SessionSourceAssertion;
            }
            const retained = withSessionTranscriptWriteAssertion(writer, target.assertCurrent, () =>
              retainConversationKnowledgePackets({
                branch,
                writeTarget: writer,
                reader: target.reader,
                packets: [packet],
              }),
            );
            if (mode === "retain") {
              expect(await retained).toMatchObject({ accepted: 1, appended: 1 });
            } else {
              await expect(retained).rejects.toThrow();
            }
            const packets = (await loadTranscriptEvents(recipient))
              .map(asOptionalRecord)
              .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT);
            expect(packets).toHaveLength(mode === "retain" ? 1 : 0);
            if (mode === "retain") {
              expect(asOptionalRecord(packets[0]?.details)?.packetId).toBe(
                conversationKnowledgePacketId(
                  conversationKnowledgeContributionId(originalReceipt),
                  0,
                ),
              );
            }
            expect(receipt).toEqual(originalReceipt);
            expect(JSON.stringify(await loadTranscriptEvents(donor))).toContain(
              "Original private fact.",
            );
          } finally {
            grant?.release();
            await f.close();
          }
        },
      );
    },
  );
});
