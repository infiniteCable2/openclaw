import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
  readActiveConversationKnowledgePacketIds,
  readConversationKnowledgePacketProgress,
  retainConversationKnowledgePacket,
  retainConversationKnowledgePackets,
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
import type { SessionSourceAssertion, SessionSourcePredicate } from "./session-source-authority.js";
import * as sourceAuthority from "./session-source-authority.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import { readSessionTranscriptModelContextAsync } from "./session-transcript-context-read.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import { withSessionTranscriptWriteAssertion } from "./transcript-write-context.js";

describe("native retained conversation knowledge packets", () => {
  it("prepares each held source once per batch without merging distinct grants or source versions", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "knowledge-packet-source-scaling" },
      async (state) => {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const base = { agentId: "main", storePath: database.path, env: state.env };
        const root = {
          sessionKey: "agent:main:batch-root",
          sessionId: "batch-root",
          lifecycleRevision: "root-life",
        };
        const donor = {
          ...base,
          sessionKey: "agent:main:batch-donor",
          sessionId: "batch-donor",
          lifecycleRevision: "donor-life",
        };
        const branch: ConversationKnowledgeBranch = {
          ...base,
          sessionKey: "agent:main:batch-recipient",
          sessionId: "batch-recipient",
          lifecycleRevision: "recipient-life",
          root,
        };
        for (const target of [root, donor, branch]) {
          await upsertSessionEntryCore(
            { ...base, ...target },
            {
              sessionId: target.sessionId,
              lifecycleRevision: target.lifecycleRevision,
              updatedAt: 1,
              conversationTopology:
                target === root
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
        const answer = appendTranscriptMessageSync(donor, {
          message: {
            role: "assistant",
            content: "A synthetic complete observation.",
            stopReason: "stop",
            timestamp: 1,
            __openclaw: { runId: "donor-run" },
          },
        });
        if (!answer.ok || !answer.value?.anchor) {
          throw new Error("Expected native donor anchor");
        }
        const receipt: ConversationKnowledgeReceipt = {
          version: 1,
          sourceMode: "branches",
          source: donor,
          origin: conversationKnowledgeOrigin(donor),
          runId: "donor-run",
          through: answer.value.anchor,
        };
        const { databaseClaim } = await loadSessionEntryForAdmission(branch);
        if (
          !("kind" in databaseClaim) ||
          databaseClaim.kind !== "worker" ||
          !databaseClaim.reader
        ) {
          await databaseClaim.release();
          throw new Error("Expected native recipient cohort");
        }
        const reader = databaseClaim.reader;
        let secondLive = true;
        let revokeOnPrepare = false;
        const firstCurrent = () => databaseClaim.assertCurrent();
        const secondCurrent = () => {
          databaseClaim.assertCurrent();
          if (!secondLive) {
            throw new Error("Synthetic second source grant revoked");
          }
        };
        const firstPrepare = vi.fn(async () => ({ assertCurrent: firstCurrent, checks: [] }));
        const secondPrepare = vi.fn(async () => {
          if (revokeOnPrepare) {
            secondLive = false;
          }
          return { assertCurrent: secondCurrent, checks: [] };
        });
        const first: SessionSourceAssertion = Object.assign(firstCurrent, {
          prepareSessionSource: firstPrepare,
        });
        const second: SessionSourceAssertion = Object.assign(secondCurrent, {
          prepareSessionSource: secondPrepare,
        });
        const prepareNative = sourceAuthority.prepareSessionSourceAuthority;
        const prefixChecks: SessionSourcePredicate[][] = [];
        const preparation = vi
          .spyOn(sourceAuthority, "prepareSessionSourceAuthority")
          .mockImplementation(async (...args) => {
            const prepared = await prepareNative(...args);
            prefixChecks.push(
              prepared.checks
                .map(({ predicate }) => predicate)
                .filter((predicate) => predicate.transcript?.consistency === "prefix"),
            );
            return prepared;
          });
        try {
          const context = await readSessionTranscriptModelContextAsync(donor, (value) => value);
          if (!context.version) {
            throw new Error("Expected native donor version");
          }
          const sourceVersion = context.version;
          const packets = Array.from({ length: 32 }, (_, offset) => ({
            receipt,
            text: `Synthetic segment ${offset}.`,
            offset,
            nextOffset: offset + 1,
            complete: false,
            sourceVersion,
            source: first,
          }));
          const retain = (batch: typeof packets) =>
            retainConversationKnowledgePackets({
              branch,
              writeTarget: branch,
              reader,
              packets: batch,
            });
          expect((await retain(packets)).appended).toBe(32);
          expect(firstPrepare).toHaveBeenCalledOnce();
          expect(secondPrepare).not.toHaveBeenCalled();
          expect(prefixChecks.at(-1)).toHaveLength(1);
          firstPrepare.mockClear();
          prefixChecks.length = 0;
          const mixed = packets.map((packet, index) => ({
            ...packet,
            offset: packet.offset + 32,
            nextOffset: packet.nextOffset + 32,
            source: index === 31 ? second : first,
          }));
          expect((await retain(mixed)).appended).toBe(32);
          expect(firstPrepare).toHaveBeenCalledOnce();
          expect(secondPrepare).toHaveBeenCalledOnce();
          expect(prefixChecks.at(-1)).toHaveLength(1);
          expect(
            appendTranscriptMessageSync(donor, {
              message: { role: "user", content: "A later observation.", timestamp: 2 },
            }).ok,
          ).toBe(true);
          const next = await readSessionTranscriptModelContextAsync(donor, (value) => value);
          if (!next.version) {
            throw new Error("Expected next native donor version");
          }
          const nextVersion = next.version;
          prefixChecks.length = 0;
          const versions = packets.map((packet, index) => ({
            ...packet,
            offset: packet.offset + 64,
            nextOffset: packet.nextOffset + 64,
            sourceVersion: index === 31 ? nextVersion : packet.sourceVersion,
          }));
          expect((await retain(versions)).appended).toBe(32);
          expect(prefixChecks.at(-1)).toHaveLength(2);
          // Every packet's donor identity is checked before predicates can coalesce.
          const invalid = [...packets];
          invalid[31] = {
            ...packets[31]!,
            receipt: { ...receipt, source: { ...donor, sessionId: "replaced-donor" } },
          };
          await expect(retain(invalid)).rejects.toThrow(
            "Conversation knowledge packet source or recipient changed",
          );
          firstPrepare.mockClear();
          secondPrepare.mockClear();
          revokeOnPrepare = true;
          await expect(retain(mixed)).rejects.toThrow("Synthetic second source grant revoked");
          expect(firstPrepare).toHaveBeenCalledOnce();
          expect(secondPrepare).toHaveBeenCalledOnce();
          expect(
            (await loadTranscriptEvents(branch))
              .map(asOptionalRecord)
              .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT),
          ).toHaveLength(96);
        } finally {
          preparation.mockRestore();
          await databaseClaim.release();
        }
      },
    );
  });
  it("retains append-preserved source progress across compaction and refuses replaced authority", async () => {
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
          // A later source turn must not invalidate an already prepared observation.
          expect(
            appendTranscriptMessageSync(source, {
              message: { role: "user", content: "A later source question.", timestamp: 3 },
            }).ok,
          ).toBe(true);
          const exactSource = await reader.withRead(
            { sessionKeys: [source.sessionKey, branch.sessionKey] },
            authority,
            (facts) =>
              ({
                source: facts.source,
                sessionKey: source.sessionKey,
                fields: ["sessionId", "lifecycleRevision"],
                expected: facts.entries.find((row) => row.sessionKey === source.sessionKey)?.entry,
                transcript: { sessionId: source.sessionId, version: originalVersion },
              }) satisfies SessionSourcePredicate,
          );
          // Other source consumers keep their exact-version contract unless they opt in.
          expect(readSessionSourceValidation(database, [exactSource]).refusedSource?.index).toBe(0);
          expect(
            readSessionSourceValidation(database, [
              {
                ...exactSource,
                transcript: { ...exactSource.transcript, consistency: "prefix" },
              },
            ]).refusedSource,
          ).toBeUndefined();
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
          const activePacketIds = () =>
            readActiveConversationKnowledgePacketIds({ branch, assertCurrent: authority });
          const firstPacketId = asOptionalRecord(firstPacket.details)?.packetId;
          expect(await activePacketIds()).toEqual([firstPacketId]);
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
          // The native compaction kept this carrier; it still needs hydration coverage.
          expect(await activePacketIds()).toEqual([firstPacketId]);
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
          await expect(retainConversationKnowledgePacket(completion)).rejects.toThrow(
            SessionTranscriptReadFenceError,
          );
          expect(await reports()).toHaveLength(1);
          await retainConversationKnowledgePacket({
            ...completion,
            sourceVersion: await version(),
          });
          expect(await reports()).toHaveLength(2);
          const completedPacket = (await reports())[1];
          const completedPacketId = asOptionalRecord(completedPacket?.details)?.packetId;
          expect(typeof completedPacket?.id).toBe("string");
          expect(
            appendTranscriptEventSync(branch, {
              type: "compaction",
              id: "recipient-compaction-two",
              summary: "Earlier imported facts are now summarized.",
              firstKeptEntryId: completedPacket!.id,
              tokensBefore: 100,
            }).ok,
          ).toBe(true);
          expect(await activePacketIds()).toEqual([completedPacketId]);
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
