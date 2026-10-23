import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readConversationKnowledgeReports } from "./conversation-knowledge-history.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
  readConversationKnowledgePacketProgress,
} from "./conversation-knowledge-packets.js";
import { CONVERSATION_KNOWLEDGE_SEED } from "./conversation-knowledge-seed.js";
import { selectConversationKnowledgeReceipts } from "./conversation-knowledge-selection.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReceipt,
} from "./conversation-knowledge.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";

// Opt-in native SQLite measurement, not a timing assertion or a default CI load test.
// This isolates reference/progress reconciliation: no source dialogue hydration,
// authorization equivalence, model inference, or end-to-end turn latency is claimed.
it.runIf(process.env.OPENCLAW_CONVERSATION_KNOWLEDGE_BENCH === "1")(
  "measures reference and packet reconciliation at increasing retained history sizes",
  async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "knowledge-scaling" },
      async ({ env }) => {
        const database = openOpenClawAgentDatabase({ agentId: "main", env });
        const base = { agentId: "main", storePath: database.path, env };
        const root = {
          sessionKey: "agent:main:internal:conversation-root",
          sessionId: "synthetic-knowledge-root",
          lifecycleRevision: "synthetic-root-revision",
        };
        const rootTarget = { ...base, ...root };
        await upsertSessionEntryCore(rootTarget, {
          sessionId: root.sessionId,
          lifecycleRevision: root.lifecycleRevision,
          updatedAt: 1,
          conversationTopology: { version: 1, role: "root" },
          createdVia: "internal",
          createdActor: { type: "system", id: "conversation-root" },
          visibility: "draft",
          delivery: { kind: "none" },
        });
        for (const references of [100, 1_000, 10_000]) {
          const receipts: ConversationKnowledgeReceipt[] = Array.from(
            { length: references },
            (_, index) => {
              const source = {
                agentId: "main",
                sessionKey: `agent:main:synthetic-source-${index % 8}`,
                sessionId: `synthetic-source-${index % 8}`,
                lifecycleRevision: "synthetic-source-revision",
              };
              return {
                version: 1,
                sourceMode: "branches",
                source,
                origin: conversationKnowledgeOrigin(source),
                runId: `synthetic-run-${index}`,
                through: {
                  ...source,
                  storePath: database.path,
                  generation: "synthetic-source-generation",
                  entryId: `synthetic-answer-${index}`,
                  rawSeq: index * 2 + 1,
                  activeMessagePosition: index * 2 + 1,
                  effectiveParentId: `synthetic-question-${index}`,
                },
              };
            },
          );
          const rootEvents: TranscriptEvent[] = receipts.map((receipt, index) => ({
            type: "custom_message",
            id: `synthetic-reference-${index}`,
            parentId: index === 0 ? "synthetic-seed" : `synthetic-reference-${index - 1}`,
            customType: CONVERSATION_KNOWLEDGE_REPORT,
            content: "Synthetic completed-conversation reference.",
            display: false,
            details: receipt,
          }));
          rootEvents.unshift({
            type: "custom_message",
            id: "synthetic-seed",
            parentId: null,
            customType: CONVERSATION_KNOWLEDGE_SEED,
            content: "Synthetic completed seed marker.",
            display: false,
            details: { version: 1, seedId: "synthetic-seed-id" },
          });
          await replaceTranscriptEvents(rootTarget, rootEvents);
          await waitForSessionTranscriptProjection(rootTarget);
          const referenceFixtureJsonBytes = Buffer.byteLength(JSON.stringify(rootEvents));
          // Compare the old broad payload selection with the native type-filtered
          // marker lookup. This measures reading, not validity of a seed receipt.
          for (const lookup of ["mixed-report-read", "seed-only-read"]) {
            for (const read of ["first-consumption", "repeated-consumption"]) {
              const cpu = process.threadCpuUsage();
              const started = performance.now();
              const reports = await readConversationKnowledgeReports({
                target: rootTarget,
                customTypes:
                  lookup === "mixed-report-read"
                    ? [CONVERSATION_KNOWLEDGE_SEED, CONVERSATION_KNOWLEDGE_REPORT]
                    : [CONVERSATION_KNOWLEDGE_SEED],
                assertCurrent() {},
              });
              const wallMs = performance.now() - started;
              const elapsedCpu = process.threadCpuUsage(cpu);
              expect(reports).toHaveLength(lookup === "mixed-report-read" ? references + 1 : 1);
              expect(reports[0]).toMatchObject({ id: "synthetic-seed" });
              console.log(
                JSON.stringify({
                  benchmark: "conversation-knowledge-seed-payload-selection",
                  references,
                  lookup,
                  read,
                  storage: "hot-sqlite-projection-ready",
                  returnedReports: reports.length,
                  returnedJsonBytes: Buffer.byteLength(JSON.stringify(reports)),
                  wallMs,
                  mainThreadCpuMs: (elapsedCpu.user + elapsedCpu.system) / 1_000,
                  sqlStatements: null,
                  storagePagesRead: null,
                  storageBytesRead: null,
                }),
              );
            }
          }
          for (const missing of [0, 1, references]) {
            const branch: ConversationKnowledgeBranch = {
              ...base,
              sessionKey: `agent:main:synthetic-recipient-${references}-${missing}`,
              sessionId: `synthetic-recipient-${references}-${missing}`,
              lifecycleRevision: "synthetic-recipient-revision",
              root,
            };
            await upsertSessionEntryCore(branch, {
              sessionId: branch.sessionId,
              lifecycleRevision: branch.lifecycleRevision,
              updatedAt: 1,
              conversationTopology: {
                version: 1,
                role: "branch",
                rootSessionKey: root.sessionKey,
                rootSessionId: root.sessionId,
                rootSessionLifecycleRevision: root.lifecycleRevision,
              },
            });
            const packetEvents: TranscriptEvent[] = receipts
              .slice(0, references - missing)
              .map((receipt, index) => ({
                type: "custom_message",
                id: `synthetic-packet-${index}`,
                parentId: index === 0 ? null : `synthetic-packet-${index - 1}`,
                customType: CONVERSATION_KNOWLEDGE_CONTEXT,
                content: "Synthetic already admitted knowledge.",
                display: false,
                details: {
                  version: 1,
                  contributionId: conversationKnowledgeContributionId(receipt),
                  rootSessionId: root.sessionId,
                  rootLifecycleRevision: root.lifecycleRevision,
                  complete: true,
                  nextOffset: 42,
                },
              }));
            await replaceTranscriptEvents(branch, packetEvents);
            await waitForSessionTranscriptProjection(branch);
            const packetFixtureJsonBytes = Buffer.byteLength(JSON.stringify(packetEvents));
            for (const read of ["first-consumption", "repeated-consumption"]) {
              const memoryBefore = process.memoryUsage();
              const cpu = process.threadCpuUsage();
              const started = performance.now();
              const reports = await readConversationKnowledgeReports({
                target: rootTarget,
                customTypes: [CONVERSATION_KNOWLEDGE_REPORT],
                assertCurrent() {},
              });
              const selected = selectConversationKnowledgeReceipts(
                reports,
                branch.sessionId,
                branch.sessionKey,
              );
              const progress = await readConversationKnowledgePacketProgress({
                branch,
                assertCurrent() {},
              });
              const pending = selected.filter(
                (receipt) => !progress.get(conversationKnowledgeContributionId(receipt))?.complete,
              );
              const wallMs = performance.now() - started;
              const elapsedCpu = process.threadCpuUsage(cpu);
              const memoryAfter = process.memoryUsage();
              expect(reports).toHaveLength(references);
              expect(selected).toHaveLength(references);
              expect(progress.size).toBe(references - missing);
              expect(pending.map((receipt) => receipt.through.entryId)).toEqual(
                receipts.slice(references - missing).map((receipt) => receipt.through.entryId),
              );
              console.log(
                JSON.stringify({
                  benchmark: "conversation-knowledge-reference-packet-reconciliation",
                  references,
                  missing,
                  read,
                  // Setup warms SQLite/projections; this is not an OS-cold or archive-restore test.
                  storage: "hot-sqlite-projection-ready",
                  referenceFixtureJsonBytes,
                  packetFixtureJsonBytes,
                  returnedReferenceJsonBytes: Buffer.byteLength(JSON.stringify(reports)),
                  selectedReferences: selected.length,
                  progressEntries: progress.size,
                  pendingReferences: pending.length,
                  wallMs,
                  mainThreadCpuMs: (elapsedCpu.user + elapsedCpu.system) / 1_000,
                  heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
                  rssAfterBytes: memoryAfter.rss,
                  // The native reader exposes neither actual SQL counts nor pages/bytes read.
                  // Fixture/result JSON sizes above must not be relabeled as storage I/O.
                  sqlStatements: null,
                  storagePagesRead: null,
                  storageBytesRead: null,
                }),
              );
            }
          }
        }
      },
    );
  },
);
