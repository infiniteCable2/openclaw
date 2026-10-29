import { inspect } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
  conversationKnowledgePacketId,
  createConversationKnowledgePacketReport,
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
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { withSessionTranscriptWriteAssertion } from "./transcript-write-context.js";

function projection(receipt: ConversationKnowledgeReceipt, text: string) {
  return JSON.stringify({
    source: receipt.origin,
    sourceSessionKey: receipt.source.sessionKey,
    throughEntryId: receipt.through.entryId,
    observations: [{ speaker: "assistant", text }],
  });
}

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
            text: projection(receipt, `Synthetic segment ${offset}.`),
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
  it("retains append-preserved source progress across compaction and refuses replaced authority", async ({
    onTestFailed,
    onTestFinished,
  }) => {
    const started = performance.now();
    const initialCpu = process.cpuUsage();
    let currentPhase = "fixture-start";
    let phaseStarted = started;
    let nextOperation = 0;
    const pending = new Map<number, { phase: string; startedMs: number }>();
    const completed: Array<{ phase: string; elapsedMs: number; failed: boolean }> = [];
    let firstFailure:
      | { phase: string; name: string; message: string; stack: string[]; causes: string[] }
      | undefined;
    const mark = (phase: string) => {
      currentPhase = phase;
      phaseStarted = performance.now();
    };
    const trace = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
      mark(phase);
      const id = ++nextOperation;
      const before = performance.now();
      pending.set(id, { phase, startedMs: Math.round(before - started) });
      let failed = true;
      try {
        const result = await operation();
        failed = false;
        return result;
      } catch (error) {
        if (!firstFailure) {
          const causes: string[] = [];
          let cause = error instanceof Error ? error.cause : undefined;
          const seen = new Set<unknown>([error]);
          while (cause !== undefined && causes.length < 3 && !seen.has(cause)) {
            seen.add(cause);
            if (cause instanceof Error) {
              causes.push(`${cause.name}: ${cause.message}`.slice(0, 1_000));
              cause = cause.cause;
            } else {
              try {
                causes.push(
                  (
                    JSON.stringify(cause) ?? inspect(cause, { customInspect: false, depth: 1 })
                  ).slice(0, 1_000),
                );
              } catch {
                causes.push(inspect(cause, { customInspect: false, depth: 1 }).slice(0, 1_000));
              }
              break;
            }
          }
          firstFailure = {
            phase,
            name: error instanceof Error ? error.name : typeof error,
            message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
            stack: error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 7) : [],
            causes,
          };
          // Fixture cleanup must finish, but must not hide the original native refusal.
          console.error(
            JSON.stringify({ scenario: "knowledge-packet-first-failure", firstFailure }),
          );
        }
        throw error;
      } finally {
        pending.delete(id);
        completed.push({ phase, elapsedMs: Math.round(performance.now() - before), failed });
        if (completed.length > 24) {
          completed.shift();
        }
      }
    };
    onTestFailed(() => {
      console.error(
        JSON.stringify({
          scenario: "knowledge-packet-compaction-authority",
          phase: currentPhase,
          phaseElapsedMs: Math.round(performance.now() - phaseStarted),
          elapsedMs: Math.round(performance.now() - started),
          pending: [...pending.values()],
          completed,
          firstFailure,
          cpuMicros: process.cpuUsage(initialCpu),
          rssBytes: process.memoryUsage().rss,
        }),
      );
    });
    await withOpenClawTestState(
      { scenario: "minimal", label: "knowledge-packets" },
      async (state) => {
        mark("setup-database");
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
          mark(`setup-entry-${entry.sessionId}`);
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
        mark("setup-source-messages");
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
        const { databaseClaim } = await trace("recipient-admission", () =>
          loadSessionEntryForAdmission(branch),
        );
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
          const context = await trace("source-version", () =>
            readSessionTranscriptModelContextAsync(source, (value) => value),
          );
          if (!context.version) {
            throw new Error("Synthetic native source version missing");
          }
          return context.version;
        };
        const reports = async () =>
          (await trace("recipient-reports", () => loadTranscriptEvents(branch)))
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
          mark("source-prefix-cohort");
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
          mark("legacy-carrier-write");
          const partial = {
            branch,
            writeTarget: branch,
            receipt,
            reader,
            sourceVersion: originalVersion,
            source: authority,
            text: projection(receipt, "First fact."),
            offset: 0,
            nextOffset: 11,
            complete: false,
          };
          const report = createConversationKnowledgePacketReport(partial);
          expect(report.details.packetId).toBe(
            conversationKnowledgePacketId(conversationKnowledgeContributionId(receipt), 0),
          );
          const legacyContent = `Retained related-conversation observations.\n${partial.text}`;
          // Raw historical carrier insertion does not initialize a native transcript.
          expect(
            appendTranscriptEventSync(
              branch,
              createSessionTranscriptHeader({ sessionId: branch.sessionId }),
            ).ok,
          ).toBe(true);
          expect(
            appendTranscriptEventSync(branch, {
              type: "custom_message",
              id: "legacy-knowledge-packet",
              ...report,
              content: legacyContent,
            }).ok,
          ).toBe(true);
          await trace("retain-partial", () => retainConversationKnowledgePacket(partial));
          await trace("retain-partial", () => retainConversationKnowledgePacket(partial));
          expect(await reports()).toHaveLength(1);
          // Receipt identity, not new rendering bytes, owns replay after an upgrade.
          expect((await reports())[0]?.content).toBe(legacyContent);
          const contributionId = conversationKnowledgeContributionId(receipt);
          const progress = () =>
            trace("recipient-progress", () =>
              readConversationKnowledgePacketProgress({ branch, assertCurrent: authority }),
            );
          expect((await progress()).get(contributionId)).toEqual({
            complete: false,
            nextOffset: 11,
          });
          const firstPacket = (await reports())[0];
          if (typeof firstPacket?.id !== "string") {
            throw new Error("Synthetic retained packet entry missing");
          }
          const activePacketIds = () =>
            trace("recipient-active-packets", () =>
              readActiveConversationKnowledgePacketIds({ branch, assertCurrent: authority }),
            );
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
          mark("source-compaction-complete");
          const completion = {
            ...partial,
            offset: 11,
            nextOffset: 23,
            text: projection(receipt, " Second fact."),
            complete: true,
          };
          await expect(
            trace("retain-stale-source", () => retainConversationKnowledgePacket(completion)),
          ).rejects.toThrow(SessionTranscriptReadFenceError);
          expect(await reports()).toHaveLength(1);
          const refreshedVersion = await version();
          await trace("retain-refreshed-source", () =>
            retainConversationKnowledgePacket({
              ...completion,
              sourceVersion: refreshedVersion,
            }),
          );
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
          mark("writer-replacement-setup");
          const recipient = loadSessionEntry(branch);
          if (!recipient) {
            throw new Error("Synthetic recipient missing");
          }
          await upsertSessionEntryCore(branch, {
            ...recipient,
            activeWriterRunId: "recipient-native-one",
          });
          const nextVersion = await version();
          mark("writer-replacement-assertion");
          await expect(
            withSessionTranscriptWriteAssertion(
              {
                ...branch,
                expectedLifecycleRevision: branch.lifecycleRevision,
                expectedWriterRunId: "recipient-native-one",
              },
              authority,
              async () => {
                mark("writer-replacement-write");
                await upsertSessionEntryCore(branch, {
                  ...recipient,
                  activeWriterRunId: "recipient-native-replacement",
                });
                mark("retain-replaced-writer");
                await retainConversationKnowledgePacket({
                  ...completion,
                  receipt: nextReceipt,
                  offset: 0,
                  text: projection(nextReceipt, "Another answer."),
                  nextOffset: 15,
                  sourceVersion: nextVersion,
                });
              },
            ),
          ).rejects.toThrow();
          expect(await reports()).toHaveLength(2);
          mark("source-revocation-setup");
          const revoked: SessionSourceAssertion = Object.assign(
            () => databaseClaim.assertCurrent(),
            {
              prepareSessionSource: async () => {
                mark("source-revocation-write");
                await upsertSessionEntryCore(source, {
                  sessionId: source.sessionId,
                  lifecycleRevision: "source-replaced",
                  updatedAt: 3,
                });
                return { assertCurrent: () => databaseClaim.assertCurrent(), checks: [] };
              },
            },
          );
          mark("retain-revoked-source");
          await expect(
            retainConversationKnowledgePacket({
              ...completion,
              receipt: nextReceipt,
              text: projection(nextReceipt, "Another answer."),
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
          await trace("cleanup-claim", () => databaseClaim.release());
          // Identify the actual native owner that has not settled. These wrappers
          // delegate unchanged; never bypass fixture draining or its safety checks.
          const scopes = await import("../../shared/async-work-scope.js");
          const stateCleanup = await import("../../test-utils/session-state-cleanup.js");
          const queues = await import("./store-writer-state.test-support.js");
          const reconcile = await import("./session-transcript-reconcile.js");
          const fileLocks = await import("../../infra/file-lock.js");
          const agentDatabases = await import("../../state/openclaw-agent-db-lifecycle.js");
          const stateDatabases = await import("../../state/openclaw-state-db.js");
          const originalScopeDrain: unknown = Object.getOwnPropertyDescriptor(
            scopes.AsyncWorkScope.prototype,
            "drain",
          )?.value;
          if (typeof originalScopeDrain !== "function") {
            completed.push({
              phase: "cleanup-work-scope-instrumentation-unavailable",
              elapsedMs: 0,
              failed: false,
            });
            if (completed.length > 24) {
              completed.shift();
            }
          }
          const original = {
            cleanup: stateCleanup.cleanupSessionStateForTest,
            queues: queues.drainSessionStoreWriterQueuesForTest,
            reconcile: reconcile.waitForSessionTranscriptIndexReconcilesInStateDir,
            locks: fileLocks.drainFileLockStateForTest,
            agents: agentDatabases.closeOpenClawAgentDatabasesAsync,
            state: stateDatabases.closeOpenClawStateDatabaseByPathAsync,
          };
          const cleanupSpies = [
            ...(typeof originalScopeDrain === "function"
              ? [
                  vi.spyOn(scopes.AsyncWorkScope.prototype, "drain").mockImplementation(function (
                    this: InstanceType<typeof scopes.AsyncWorkScope>,
                  ) {
                    return trace("cleanup-work-scope", async () => {
                      await Reflect.apply(originalScopeDrain, this, []);
                    });
                  }),
                ]
              : []),
            vi
              .spyOn(stateCleanup, "cleanupSessionStateForTest")
              .mockImplementation((...args) =>
                trace("cleanup-session-state", () => original.cleanup(...args)),
              ),
            vi
              .spyOn(queues, "drainSessionStoreWriterQueuesForTest")
              .mockImplementation((...args) =>
                trace("cleanup-writer-queues", () => original.queues(...args)),
              ),
            vi
              .spyOn(reconcile, "waitForSessionTranscriptIndexReconcilesInStateDir")
              .mockImplementation((...args) =>
                trace("cleanup-transcript-reconcile", () => original.reconcile(...args)),
              ),
            vi
              .spyOn(fileLocks, "drainFileLockStateForTest")
              .mockImplementation((...args) =>
                trace("cleanup-file-locks", () => original.locks(...args)),
              ),
            vi
              .spyOn(agentDatabases, "closeOpenClawAgentDatabasesAsync")
              .mockImplementation((...args) =>
                trace("cleanup-agent-databases", () => original.agents(...args)),
              ),
            vi
              .spyOn(stateDatabases, "closeOpenClawStateDatabaseByPathAsync")
              .mockImplementation((...args) =>
                trace("cleanup-state-database", () => original.state(...args)),
              ),
          ];
          onTestFinished(() => {
            for (const spy of cleanupSpies.toReversed()) {
              spy.mockRestore();
            }
          });
          mark("cleanup-fixture");
        }
      },
    );
  });
});
