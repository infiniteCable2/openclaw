import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
  readConversationKnowledgePacketProgress,
  retainConversationKnowledgePacket,
} from "./conversation-knowledge-packets.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import {
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReceipt,
} from "./conversation-knowledge.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import { readSessionTranscriptModelContextAsync } from "./session-transcript-context-read.js";
import { withSessionTranscriptWriteAssertion } from "./transcript-write-context.js";

describe("native retained conversation knowledge packets", () => {
  it("persists partial progress exactly once across compaction and refuses replaced source authority", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "knowledge-packets" },
      async (state) => {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const root = {
          sessionKey: "agent:main:main",
          sessionId: "knowledge-root",
          lifecycleRevision: "root-original",
        };
        const base = { agentId: "main", storePath: database.path, env: state.env };
        const source = {
          ...base,
          sessionKey: "agent:main:knowledge-source",
          sessionId: "knowledge-source",
          lifecycleRevision: "source-original",
        };
        const branch: ConversationKnowledgeBranch = {
          ...base,
          sessionKey: "agent:main:knowledge-target",
          sessionId: "knowledge-target",
          lifecycleRevision: "target-original",
          root,
        };
        for (const entry of [source, branch, root]) {
          await upsertSessionEntryCore(
            { ...base, ...entry },
            {
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
              updatedAt: 1,
              conversationTopology:
                entry === root
                  ? { version: 1, role: "root" }
                  : {
                      version: 1,
                      role: "branch",
                      rootSessionKey: root.sessionKey,
                      rootSessionId: root.sessionId,
                      rootSessionLifecycleRevision: root.lifecycleRevision,
                    },
            },
          );
        }
        expect(
          appendTranscriptMessageSync(source, {
            message: { role: "user", content: "A complete source question.", timestamp: 1 },
          }).ok,
        ).toBe(true);
        const answer = appendTranscriptMessageSync(source, {
          message: {
            role: "assistant",
            content: "First fact. Second fact.",
            stopReason: "stop",
            timestamp: 2,
            __openclaw: { runId: "source-run" },
          },
        });
        if (!answer.ok || !answer.value?.anchor) {
          throw new Error("Synthetic native source anchor missing");
        }
        const receipt: ConversationKnowledgeReceipt = {
          version: 1,
          sourceMode: "branches",
          source,
          origin: conversationKnowledgeOrigin(source),
          runId: "source-run",
          through: answer.value.anchor,
        };
        const { databaseClaim } = await loadSessionEntryForAdmission(branch);
        if (
          !("kind" in databaseClaim) ||
          databaseClaim.kind !== "worker" ||
          !databaseClaim.reader
        ) {
          await databaseClaim.release();
          throw new Error("Synthetic native recipient cohort missing");
        }
        const reader = databaseClaim.reader;
        const authority: SessionSourceAssertion = Object.assign(
          () => databaseClaim.assertCurrent(),
          {
            prepareSessionSource: async () => ({
              assertCurrent: () => databaseClaim.assertCurrent(),
              checks: [],
            }),
          },
        );
        const version = async () => {
          const context = await readSessionTranscriptModelContextAsync(source, (value) => value);
          if (!context.version) {
            throw new Error("Synthetic native source version missing");
          }
          return context.version;
        };
        const reports = async () =>
          (await loadTranscriptEvents(branch))
            .map(asOptionalRecord)
            .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT);
        try {
          const originalVersion = await version();
          const partial = {
            branch,
            writeTarget: branch,
            receipt,
            reader,
            sourceVersion: originalVersion,
            source: authority,
            text: "First fact.",
            offset: 0,
            nextOffset: 11,
            complete: false,
          };
          await retainConversationKnowledgePacket(partial);
          await retainConversationKnowledgePacket(partial);
          expect(await reports()).toHaveLength(1);
          const contributionId = conversationKnowledgeContributionId(receipt);
          const progress = () =>
            readConversationKnowledgePacketProgress({ branch, assertCurrent: authority });
          expect((await progress()).get(contributionId)).toEqual({
            complete: false,
            nextOffset: 11,
          });
          const firstPacket = (await reports())[0];
          if (typeof firstPacket?.id !== "string") {
            throw new Error("Synthetic retained packet entry missing");
          }
          expect(
            appendTranscriptEventSync(branch, {
              type: "compaction",
              id: "recipient-compaction",
              summary: "A retained first fact.",
              firstKeptEntryId: firstPacket.id,
              tokensBefore: 100,
            }).ok,
          ).toBe(true);
          expect((await progress()).get(contributionId)).toEqual({
            complete: false,
            nextOffset: 11,
          });
          expect(
            appendTranscriptEventSync(source, {
              type: "compaction",
              id: "source-compaction",
              summary: "A source summary.",
              firstKeptEntryId: receipt.through.entryId,
              tokensBefore: 100,
            }).ok,
          ).toBe(true);
          const completion = {
            ...partial,
            offset: 11,
            nextOffset: 23,
            text: " Second fact.",
            complete: true,
          };
          await expect(retainConversationKnowledgePacket(completion)).rejects.toThrow();
          expect(await reports()).toHaveLength(1);
          await retainConversationKnowledgePacket({
            ...completion,
            sourceVersion: await version(),
          });
          expect(await reports()).toHaveLength(2);
          expect((await progress()).get(contributionId)).toEqual({
            complete: true,
            nextOffset: 23,
          });
          expect(
            appendTranscriptMessageSync(source, {
              message: { role: "user", content: "Another question.", timestamp: 3 },
            }).ok,
          ).toBe(true);
          const nextAnswer = appendTranscriptMessageSync(source, {
            message: {
              role: "assistant",
              content: "Another answer.",
              stopReason: "stop",
              timestamp: 4,
              __openclaw: { runId: "second-source-run" },
            },
          });
          if (!nextAnswer.ok || !nextAnswer.value?.anchor) {
            throw new Error("Synthetic next source anchor missing");
          }
          const nextReceipt = {
            ...receipt,
            runId: "second-source-run",
            through: nextAnswer.value.anchor,
          };
          const recipient = loadSessionEntry(branch);
          if (!recipient) {
            throw new Error("Synthetic recipient missing");
          }
          await upsertSessionEntryCore(branch, {
            ...recipient,
            activeWriterRunId: "recipient-native-one",
          });
          const nextVersion = await version();
          await expect(
            withSessionTranscriptWriteAssertion(
              {
                ...branch,
                expectedLifecycleRevision: branch.lifecycleRevision,
                expectedWriterRunId: "recipient-native-one",
              },
              authority,
              async () => {
                await upsertSessionEntryCore(branch, {
                  ...recipient,
                  activeWriterRunId: "recipient-native-replacement",
                });
                await retainConversationKnowledgePacket({
                  ...completion,
                  receipt: nextReceipt,
                  offset: 0,
                  text: "Another answer.",
                  nextOffset: 15,
                  sourceVersion: nextVersion,
                });
              },
            ),
          ).rejects.toThrow();
          expect(await reports()).toHaveLength(2);
          const revoked: SessionSourceAssertion = Object.assign(
            () => databaseClaim.assertCurrent(),
            {
              prepareSessionSource: async () => {
                await upsertSessionEntryCore(source, {
                  sessionId: source.sessionId,
                  lifecycleRevision: "source-replaced",
                  updatedAt: 3,
                });
                return { assertCurrent: () => databaseClaim.assertCurrent(), checks: [] };
              },
            },
          );
          await expect(
            retainConversationKnowledgePacket({
              ...completion,
              receipt: nextReceipt,
              text: "Another answer.",
              offset: 0,
              nextOffset: 15,
              sourceVersion: await version(),
              source: revoked,
            }),
          ).rejects.toThrow();
          expect(await reports()).toHaveLength(2);
          expect((await progress()).get(contributionId)).toEqual({
            complete: true,
            nextOffset: 23,
          });
        } finally {
          await databaseClaim.release();
        }
      },
    );
  });
});
