import { AsyncLocalStorage } from "node:async_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { createConversationContextCapacity } from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import * as knowledgePacketReads from "../../config/sessions/conversation-knowledge-packets.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
} from "../../config/sessions/conversation-knowledge-packets.js";
import { selectConversationKnowledgeReceipts } from "../../config/sessions/conversation-knowledge-selection.js";
import * as knowledgeStoreReads from "../../config/sessions/conversation-knowledge-store.js";
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
import { MAX_TRANSCRIPT_REPORT_BATCH_SIZE } from "../../config/sessions/session-accessor.sqlite-transcript-reports.types.js";
import * as transcriptAnchors from "../../config/sessions/session-transcript-anchor-read.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import * as transcriptReadAuthority from "../../gateway/session-transcript-read-authority.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as branchAuthority from "./conversation-knowledge-authority.js";
import { prepareConversationKnowledgeRecipient } from "./conversation-knowledge-prefetch.js";
import { createReplyConversationKnowledgeTurn } from "./conversation-knowledge-turn.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";
import { lifecycleAdmissionByOperation } from "./reply-run-registry.state.js";
import { createMockFollowupRun, createMockReplyOperation } from "./test-helpers.js";

const budget = vi.hoisted(() => ({ compact: vi.fn() }));
// Actual SQLite, source authorization, read-ahead, request capacity and packet commits remain real.
// mock-isolation: This recipient harness must never initialize model compaction.
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
const recipientLedgerEvents = simulationInteger(
  "OPENCLAW_TEST_KNOWLEDGE_RECIPIENT_LEDGER_EVENTS",
  40,
  0,
  5_000,
);
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
      const appendBatch = reportStorage.appendSessionTranscriptReportBatch;
      const batch = vi.spyOn(reportStorage, "appendSessionTranscriptReportBatch");
      const foreground = new AsyncLocalStorage<boolean>();
      const newSpan = () => ({ calls: 0, ms: 0, maxMs: 0, entries: 0 });
      const newSpans = () => ({
        appendBatch: newSpan(),
        grant: newSpan(),
        branchFacts: newSpan(),
        anchors: newSpan(),
      });
      const spans = { outsideRefresh: newSpans(), foreground: newSpans() };
      const timed = async <T>(
        kind: keyof ReturnType<typeof newSpans>,
        run: () => Promise<T>,
        entries = 0,
      ): Promise<T> => {
        const span = (foreground.getStore() ? spans.foreground : spans.outsideRefresh)[kind];
        span.calls++;
        span.entries += entries;
        const started = performance.now();
        try {
          return await run();
        } finally {
          const elapsed = performance.now() - started;
          span.ms += elapsed;
          span.maxMs = Math.max(span.maxMs, elapsed);
        }
      };
      batch.mockImplementation((...args) =>
        timed("appendBatch", () => appendBatch(...args), args[1].length),
      );
      const prepareGrant = transcriptReadAuthority.prepareTranscriptReadAuthority;
      const prepareFacts = branchAuthority.prepareConversationKnowledgeBranchFacts;
      const readAnchors = transcriptAnchors.readSessionTranscriptAnchorsAsync;
      const grantRead = vi
        .spyOn(transcriptReadAuthority, "prepareTranscriptReadAuthority")
        .mockImplementation((...args) => timed("grant", () => prepareGrant(...args)));
      const factsRead = vi
        .spyOn(branchAuthority, "prepareConversationKnowledgeBranchFacts")
        .mockImplementation((...args) => timed("branchFacts", () => prepareFacts(...args)));
      const anchorRead = vi
        .spyOn(transcriptAnchors, "readSessionTranscriptAnchorsAsync")
        .mockImplementation((...args) => timed("anchors", () => readAnchors(...args)));
      const reads = {
        background: {
          root: 0,
          progress: 0,
          rootMs: 0,
          progressMs: 0,
          observe: 0,
          observeMs: 0,
          observeQueries: 0,
          maxObserveQueries: 0,
          missing: 0,
        },
        foreground: {
          root: 0,
          progress: 0,
          rootMs: 0,
          progressMs: 0,
          observe: 0,
          observeMs: 0,
          observeQueries: 0,
          maxObserveQueries: 0,
          missing: 0,
        },
      };
      const readRoot = knowledgeStoreReads.readConversationKnowledgeRoot;
      const readProgress = knowledgePacketReads.readConversationKnowledgePacketProgress;
      const observeReceipts = reportStorage.readSessionTranscriptReportReceipts;
      // Delegating spies classify the actual owners; detached background work must
      // not inherit the foreground lane while native source/storage behavior stays real.
      const rootRead = vi
        .spyOn(knowledgeStoreReads, "readConversationKnowledgeRoot")
        .mockImplementation(async (...args) => {
          const lane = foreground.getStore() ? reads.foreground : reads.background;
          lane.root++;
          const started = performance.now();
          try {
            return await readRoot(...args);
          } finally {
            lane.rootMs += performance.now() - started;
          }
        });
      const progressRead = vi
        .spyOn(knowledgePacketReads, "readConversationKnowledgePacketProgress")
        .mockImplementation(async (...args) => {
          const lane = foreground.getStore() ? reads.foreground : reads.background;
          lane.progress++;
          const started = performance.now();
          try {
            return await readProgress(...args);
          } finally {
            lane.progressMs += performance.now() - started;
          }
        });
      const observeRead = vi
        .spyOn(reportStorage, "readSessionTranscriptReportReceipts")
        .mockImplementation(async (...args) => {
          const lane = foreground.getStore() ? reads.foreground : reads.background;
          lane.observe++;
          lane.observeQueries += args[1].length;
          lane.maxObserveQueries = Math.max(lane.maxObserveQueries, args[1].length);
          const started = performance.now();
          try {
            const result = await observeReceipts(...args);
            if (result.ok) {
              lane.missing += result.value.filter((entry) => entry.status === "missing").length;
            }
            return result;
          } finally {
            lane.observeMs += performance.now() - started;
          }
        });
      let prefetch: ReturnType<typeof prepareConversationKnowledgeRecipient>;
      let releaseKnowledge = () => {};
      budget.compact.mockClear();
      try {
        const chat = await fixture.branch("throughput-chat");
        const previousCall = await fixture.branch("throughput-prior-call");
        const recipient = await fixture.branch("throughput-recipient");
        const rootLifecycleRevision = loadSessionEntry(fixture.root)!.lifecycleRevision;
        const ledgerPacketIds = new Set(
          Array.from({ length: recipientLedgerEvents }, (_, index) => `ledger-packet-${index}`),
        );
        await replaceTranscriptEvents(recipient, [
          { type: "session", id: recipient.sessionId, version: CURRENT_SESSION_VERSION },
          ...Array.from({ length: recipientLedgerEvents }, (_, index) => ({
            type: "custom_message",
            id: `ledger-entry-${index}`,
            parentId: index === 0 ? null : `ledger-entry-${index - 1}`,
            customType: CONVERSATION_KNOWLEDGE_CONTEXT,
            content: "A synthetic previously retained observation. ".repeat(8),
            display: false,
            details: {
              version: 1,
              packetId: `ledger-packet-${index}`,
              contributionId: `ledger-contribution-${index}`,
              rootSessionId: fixture.root.sessionId,
              rootLifecycleRevision,
              offset: 0,
              nextOffset: 1,
              complete: true,
            },
          })),
        ]);
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
        const receipts = await fixture.receipts();
        const expectedContributions = new Set(receipts.map(conversationKnowledgeContributionId));
        const idleSlots = prefetch.cache.preparedPackets(Number.MAX_SAFE_INTEGER);
        expect(new Set(idleSlots.map((slot) => slot.contributionId))).toEqual(
          expectedContributions,
        );
        let idlePreparedBytes = 0;
        let idlePreparedPackets = 0;
        for (const receipt of receipts) {
          const id = conversationKnowledgeContributionId(receipt);
          let offset = 0;
          let complete = false;
          const visited = new Set<number>();
          for (let count = 0; count <= idleSlots.length; count++) {
            expect(visited.has(offset), "idle staged offsets must not cycle").toBe(false);
            visited.add(offset);
            const staged = prefetch.cache.peek(id, offset);
            if (!staged) {
              throw new Error(`Idle preparation did not finish contribution ${id} at ${offset}`);
            }
            expect(staged.through.entryId).toBe(receipt.through.entryId);
            idlePreparedBytes += Buffer.byteLength(JSON.stringify(staged));
            idlePreparedPackets++;
            if (staged.part.complete) {
              expect(staged.part.frontier).toBeDefined();
              complete = true;
              break;
            }
            expect(staged.part.nextOffset).toBeGreaterThan(offset);
            offset = staged.part.nextOffset!;
          }
          expect(complete, "idle source preparation must reach its final segment").toBe(true);
          expect(visited.size).toBe(idleSlots.filter((slot) => slot.contributionId === id).length);
        }
        expect(idlePreparedPackets).toBe(idleSlots.length);
        expect(idlePreparedBytes).toBeLessThanOrEqual(prefetch.cache.maxPreparedRootBytes);
        const manifest = prefetch.cache.preparedRoot;
        if (!manifest) {
          throw new Error("Idle preparation must publish its native root provenance");
        }
        const preparedRoot = await knowledgeStoreReads.readPreparedConversationKnowledgeRoot({
          ...recipientClaim,
          branch,
          manifest,
          signal,
        });
        const readyContributions = new Set(
          selectConversationKnowledgeReceipts(
            preparedRoot,
            branch.sessionId,
            branch.sessionKey,
          ).map(conversationKnowledgeContributionId),
        );
        const withinNativeManifest = expectedContributions.size <= MAX_TRANSCRIPT_REPORT_BATCH_SIZE;
        if (withinNativeManifest) {
          expect(readyContributions).toEqual(expectedContributions);
        } else {
          // Larger simulations roll the existing bounded provenance window after
          // admission; cached future bytes are not claimed as current grants.
          expect(readyContributions.size).toBe(MAX_TRANSCRIPT_REPORT_BATCH_SIZE);
          expect([...readyContributions].every((id) => expectedContributions.has(id))).toBe(true);
        }
        batch.mockClear();
        const { replyOperation } = createMockReplyOperation({
          key: recipient.sessionKey,
          sessionId: recipient.sessionId,
        });
        lifecycleAdmissionByOperation.set(replyOperation, { reader: recipientClaim.reader });
        releaseKnowledge = () => {
          lifecycleAdmissionByOperation.delete(replyOperation);
        };
        const followupRun = createMockFollowupRun({
          conversationParticipant: person,
          conversationAudience: audience,
          run: { ...target, config: fixture.cfg },
        });
        const admission = prepareAgentRunAdmission({
          cfg: fixture.cfg,
          operationalRunInstance: createOperationalRunInstanceRef(writer.expectedWriterRunId),
          assertSourceCurrent: recipientClaim.assertCurrent,
          facts: {
            runId: writer.expectedWriterRunId,
            agentId: recipient.agentId,
            ingress: { kind: "channel", boundary: "knowledge-throughput-test", state: "present" },
          },
        });
        const knowledge = createReplyConversationKnowledgeTurn({
          turn: { isHeartbeat: false, followupRun, replyOperation },
          originalSource: recipientClaim.assertCurrent,
          getRuntimeConfig: () => fixture.cfg,
        });
        if (!knowledge) {
          throw new Error("Expected the actual native knowledge-turn boundary");
        }
        releaseKnowledge = () => {
          lifecycleAdmissionByOperation.delete(replyOperation);
          knowledge.release();
        };
        await knowledge.prepare(admission, signal);
        await withSessionTranscriptWriteAssertion(writer, recipientClaim.assertCurrent, () =>
          knowledge.prepareHistory({
            ...followupRun.run,
            runId: writer.expectedWriterRunId,
            prompt: "Recall the prepared observations.",
            sessionTarget: writer,
            contextTokenBudget: 1_000_000,
          }),
        );
        const contextIdentity = {};
        const admit = () =>
          foreground.run(true, () =>
            withSessionTranscriptWriteAssertion(writer, recipientClaim.assertCurrent, () =>
              knowledge.refreshPrepared({
                signal,
                contextIdentity,
                canAdmit: createConversationContextCapacity({
                  messages: [],
                  contextWindow: 1_000_000,
                  reserveTokens: 16_384,
                }),
              }),
            ),
          );
        const readPackets = async () =>
          (await loadTranscriptEvents(recipient))
            .map(asOptionalRecord)
            .filter(
              (event) =>
                event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT &&
                !ledgerPacketIds.has(String(asOptionalRecord(event.details)?.packetId)),
            );
        let boundaryCount = 0;
        let admissionMs = 0;
        let continuationWaitMs = 0;
        let maxAdmissionMs = 0;
        let packets = await readPackets();
        for (; boundaryCount < 512; boundaryCount++) {
          signal.throwIfAborted();
          const previousPacketCount = packets.length;
          const previousRevision = prefetch.cache.revision;
          const admissionStarted = performance.now();
          await admit();
          const elapsed = performance.now() - admissionStarted;
          admissionMs += elapsed;
          maxAdmissionMs = Math.max(maxAdmissionMs, elapsed);
          // refreshPrepared itself requests the real existing preparation owner
          // after consuming packets. Join that work; do not create model calls,
          // synthetic root publications, polling sleeps or a second scheduler.
          const waitStarted = performance.now();
          await prefetch.owner.wait();
          continuationWaitMs += performance.now() - waitStarted;
          packets = await readPackets();
          const complete = new Set(
            packets.flatMap((packet) => {
              const details = asOptionalRecord(packet!.details);
              return details?.complete === true && typeof details.contributionId === "string"
                ? [details.contributionId]
                : [];
            }),
          );
          if ([...expectedContributions].every((id) => complete.has(id))) {
            boundaryCount++;
            break;
          }
          expect(
            packets.length > previousPacketCount || prefetch.cache.revision !== previousRevision,
            "the actual preparation owner and natural boundary must make observable progress",
          ).toBe(true);
        }
        expect(
          boundaryCount,
          "all contributions must finish through bounded native boundaries",
        ).toBeLessThan(512);
        if (withinNativeManifest) {
          expect(
            boundaryCount,
            "fully staged data must drain near the native receipt quantum",
          ).toBeLessThanOrEqual(
            Math.ceil(idlePreparedPackets / MAX_TRANSCRIPT_REPORT_BATCH_SIZE) + 1,
          );
        }
        expect(packets.length).toBeGreaterThanOrEqual(markers.length + 1);
        expect(
          new Set(packets.map((packet) => asOptionalRecord(packet!.details)?.contributionId)),
        ).toEqual(new Set(receipts.map(conversationKnowledgeContributionId)));
        const markerByRun = new Map(
          markers.map((marker, index) => [`throughput-chat-${index}`, marker]),
        );
        markerByRun.set("throughput-prior-call", callMarker);
        for (const receipt of receipts) {
          const id = conversationKnowledgeContributionId(receipt);
          const own = packets.filter(
            (packet) => asOptionalRecord(packet!.details)?.contributionId === id,
          );
          expect(own.length).toBeGreaterThan(0);
          expect(asOptionalRecord(own[0]!.details)?.offset).toBe(0);
          for (let index = 1; index < own.length; index++) {
            expect(asOptionalRecord(own[index]!.details)?.offset).toBe(
              asOptionalRecord(own[index - 1]!.details)?.nextOffset,
            );
          }
          expect(asOptionalRecord(own.at(-1)!.details)?.complete).toBe(true);
          // Fair interleaving may deliver another contribution while a long one
          // continues. Reconstruct its actual quoted segments in stored offset
          // order, including markers that straddle packet cuts.
          const text = own
            .map((packet) => {
              if (typeof packet!.content !== "string") {
                throw new Error("Expected native quoted packet text");
              }
              const quoted = asOptionalRecord(
                JSON.parse(packet!.content.slice(packet!.content.indexOf("\n") + 1)),
              );
              if (!Array.isArray(quoted?.observations)) {
                throw new Error("Expected native observation segments");
              }
              return quoted.observations
                .map((observation) => {
                  const text = asOptionalRecord(observation)?.text;
                  if (typeof text !== "string") {
                    throw new Error("Expected native observation text");
                  }
                  return text;
                })
                .join("");
            })
            .join("");
          const marker = markerByRun.get(receipt.runId);
          expect(marker).toBeDefined();
          expect(text).toContain(marker!);
          expect(text).not.toContain("ARCHIVE_ONLY_");
        }
        expect(
          new Set(packets.map((packet) => asOptionalRecord(packet!.details)?.packetId)).size,
        ).toBe(packets.length);
        const batchCalls = batch.mock.calls.length;
        expect(batchCalls).toBeGreaterThan(0);
        expect(
          batch.mock.calls.every(([, entries]) => entries.length > 0 && entries.length <= 32),
        ).toBe(true);
        expect(reads.foreground.root).toBe(0);
        expect(reads.foreground.progress).toBe(0);
        expect(reads.foreground.observe).toBeGreaterThan(0);
        expect(reads.foreground.maxObserveQueries).toBeLessThanOrEqual(32);
        expect(reads.foreground.missing).toBeGreaterThanOrEqual(packets.length);
        if (simulation) {
          console.info(
            JSON.stringify({
              benchmark: "recipient-readiness-and-native-consumption",
              historyEvents,
              recipientLedgerEvents,
              contributions: markers.length + 1,
              packets: packets.length,
              sources: 2,
              observationRepeat,
              nativeBatchCalls: batchCalls,
              compactionCalls: budget.compact.mock.calls.length,
              setupMs,
              preparationMs,
              idlePreparedPackets,
              idlePreparedBytes,
              immediatelyProvenContributions: readyContributions.size,
              withinNativeManifest,
              boundaryCount,
              admissionMs,
              maxAdmissionMs,
              continuationWaitMs,
              reads,
              spans,
              timingSemantics:
                "inclusive nested spans; outsideRefresh includes setup and detached preparation; do not sum overlapping owners",
              harnessRssBefore: rssBefore,
              harnessRssAfter: process.memoryUsage().rss,
              processLifetimePeakRssKiB: process.resourceUsage().maxRSS,
              mocked: "model compaction module, expected never called",
              real: "SQLite, compiled workers, source authority, bounded read-ahead, actual knowledge-turn boundaries and owner wakeups, native request capacity, exact packet receipts and admitted writer",
              modelPreparationCoveredSeparately: true,
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
        ).toHaveLength(recipientLedgerEvents + packets.length);
      } finally {
        releaseKnowledge();
        batch.mockRestore();
        rootRead.mockRestore();
        progressRead.mockRestore();
        observeRead.mockRestore();
        grantRead.mockRestore();
        factsRead.mockRestore();
        anchorRead.mockRestore();
        await prefetch?.owner.close();
        await fixture.close();
      }
    },
  );
});
