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
import {
  MAX_TRANSCRIPT_REPORT_BATCH_SIZE,
  type TranscriptReportWorkerOperations,
} from "../../config/sessions/session-accessor.sqlite-transcript-reports.types.js";
import * as sourceAuthority from "../../config/sessions/session-source-authority.js";
import * as transcriptAnchors from "../../config/sessions/session-transcript-anchor-read.js";
import * as reportOperation from "../../config/sessions/session-transcript-report-operation.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import * as personalReadAuthority from "../../gateway/session-transcript-personal-read.js";
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
  10_000,
  1,
  60_000,
);

it("prepares long-source observations while idle and consumes them once through the admitted writer", async ({
  signal,
  onTestFailed,
}) => {
  const diagnosticStarted = performance.now();
  const diagnosticCpu = process.cpuUsage();
  let phase = "state:create";
  let phaseStarted = diagnosticStarted;
  const phases: Array<{ phase: string; startedMs: number }> = [];
  const mark = (next: string) => {
    phase = next;
    phaseStarted = performance.now();
    phases.push({ phase, startedMs: Math.round(phaseStarted - diagnosticStarted) });
    if (phases.length > 24) {
      phases.shift();
    }
  };
  let inspectFailure: () => unknown = () => ({});
  onTestFailed(() => {
    console.error(
      JSON.stringify({
        scenario: "knowledge-recipient-throughput-failure",
        phase,
        phaseElapsedMs: Math.round(performance.now() - phaseStarted),
        elapsedMs: Math.round(performance.now() - diagnosticStarted),
        aborted: signal.aborted,
        cpuMicroseconds: process.cpuUsage(diagnosticCpu),
        rssBytes: process.memoryUsage().rss,
        phases,
        state: inspectFailure(),
      }),
    );
  });
  await withOpenClawTestState(
    { scenario: "minimal", label: "knowledge-recipient-throughput" },
    async (state) => {
      const setupStarted = performance.now();
      mark("setup:create-native-fixture");
      const fixture = await createConversationKnowledgeScenario(state);
      const appendBatch = reportStorage.appendSessionTranscriptReportBatch;
      const batch = vi.spyOn(reportStorage, "appendSessionTranscriptReportBatch");
      const foreground = new AsyncLocalStorage<boolean>();
      const newSpan = () => ({
        calls: 0,
        ms: 0,
        maxMs: 0,
        entries: 0,
        pending: 0,
        lastStartedMs: 0,
      });
      const newSpans = () => ({
        appendBatch: newSpan(),
        grant: newSpan(),
        branchFacts: newSpan(),
        anchors: newSpan(),
        reportBeforeCallback: newSpan(),
        reportCallback: newSpan(),
        reportAfterCallback: newSpan(),
        reportAppendExecute: newSpan(),
        reportOtherExecute: newSpan(),
        reportAssert: newSpan(),
        reportPublish: newSpan(),
        reportSourcePrepare: newSpan(),
        reportSourceAccept: newSpan(),
      });
      const spans = { outsideRefresh: newSpans(), foreground: newSpans() };
      const spanFor = (kind: keyof ReturnType<typeof newSpans>) =>
        (foreground.getStore() ? spans.foreground : spans.outsideRefresh)[kind];
      const recordSpan = (kind: keyof ReturnType<typeof newSpans>, started: number) => {
        const span = spanFor(kind);
        const elapsed = performance.now() - started;
        span.calls++;
        span.ms += elapsed;
        span.maxMs = Math.max(span.maxMs, elapsed);
      };
      const reportOwner = new AsyncLocalStorage<boolean>();
      const withReportWorker = reportOperation.withReportWorker;
      const reportWorker = vi
        .spyOn(reportOperation, "withReportWorker")
        .mockImplementation((scope, kind, run, ...rest) => {
          if (kind !== "append") {
            return withReportWorker(scope, kind, run, ...rest);
          }
          return reportOwner.run(true, async () => {
            const started = performance.now();
            let callbackFinished: number | undefined;
            try {
              return await withReportWorker(
                scope,
                kind,
                async (operation, assertCurrent, publish) => {
                  recordSpan("reportBeforeCallback", started);
                  const execute = operation.execute;
                  const timedExecute: typeof operation.execute = <
                    Key extends keyof TranscriptReportWorkerOperations,
                  >(
                    command: { type: Key; input: TranscriptReportWorkerOperations[Key]["input"] },
                    options?: { signal?: AbortSignal },
                  ) =>
                    timed(
                      command.type === "appendBatch" ? "reportAppendExecute" : "reportOtherExecute",
                      () => execute(command, options),
                    );
                  const execution = vi.spyOn(operation, "execute").mockImplementation(timedExecute);
                  const callbackStarted = performance.now();
                  const measureSync = <T>(
                    name: "reportAssert" | "reportPublish",
                    invoke: () => T,
                  ) => {
                    const began = performance.now();
                    try {
                      return invoke();
                    } finally {
                      recordSpan(name, began);
                    }
                  };
                  try {
                    return await run(
                      operation,
                      () => measureSync("reportAssert", assertCurrent),
                      (publication) => measureSync("reportPublish", () => publish(publication)),
                    );
                  } finally {
                    recordSpan("reportCallback", callbackStarted);
                    callbackFinished = performance.now();
                    execution.mockRestore();
                  }
                },
                ...rest,
              );
            } finally {
              recordSpan(
                callbackFinished === undefined ? "reportBeforeCallback" : "reportAfterCallback",
                callbackFinished ?? started,
              );
            }
          });
        });
      const prepareSource = sourceAuthority.prepareSessionSourceAuthority;
      const reportSource = vi
        .spyOn(sourceAuthority, "prepareSessionSourceAuthority")
        .mockImplementation((...args) => {
          if (!reportOwner.getStore()) {
            return prepareSource(...args);
          }
          const span = spanFor("reportSourcePrepare");
          return timed("reportSourcePrepare", () => prepareSource(...args)).then((prepared) => {
            span.entries += prepared.checks.length;
            return prepared;
          });
        });
      const acceptSource = sourceAuthority.acceptSessionSourceValidation;
      const reportAccepted = vi
        .spyOn(sourceAuthority, "acceptSessionSourceValidation")
        .mockImplementation((...args) => {
          if (!reportOwner.getStore()) {
            return acceptSource(...args);
          }
          const started = performance.now();
          spanFor("reportSourceAccept").entries += args[0].checks.length;
          try {
            return acceptSource(...args);
          } finally {
            recordSpan("reportSourceAccept", started);
          }
        });
      const timed = async <T>(
        kind: keyof ReturnType<typeof newSpans>,
        run: () => Promise<T>,
        entries = 0,
      ): Promise<T> => {
        const span = (foreground.getStore() ? spans.foreground : spans.outsideRefresh)[kind];
        span.calls++;
        span.entries += entries;
        const started = performance.now();
        span.pending++;
        span.lastStartedMs = Math.round(started - diagnosticStarted);
        try {
          return await run();
        } finally {
          span.pending--;
          const elapsed = performance.now() - started;
          span.ms += elapsed;
          span.maxMs = Math.max(span.maxMs, elapsed);
        }
      };
      batch.mockImplementation((...args) =>
        timed("appendBatch", () => appendBatch(...args), args[1].length),
      );
      const prepareGrant = personalReadAuthority.preparePersonalConversationRead;
      const prepareFacts = branchAuthority.prepareConversationKnowledgeBranchFacts;
      const readAnchors = transcriptAnchors.readSessionTranscriptAnchorsAsync;
      const grantRead = vi
        .spyOn(personalReadAuthority, "preparePersonalConversationRead")
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
          rootPending: 0,
          progressPending: 0,
          observePending: 0,
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
          rootPending: 0,
          progressPending: 0,
          observePending: 0,
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
          lane.rootPending++;
          const started = performance.now();
          try {
            return await readRoot(...args);
          } finally {
            lane.rootPending--;
            lane.rootMs += performance.now() - started;
          }
        });
      const progressRead = vi
        .spyOn(knowledgePacketReads, "readConversationKnowledgePacketProgress")
        .mockImplementation(async (...args) => {
          const lane = foreground.getStore() ? reads.foreground : reads.background;
          lane.progress++;
          lane.progressPending++;
          const started = performance.now();
          try {
            return await readProgress(...args);
          } finally {
            lane.progressPending--;
            lane.progressMs += performance.now() - started;
          }
        });
      const observeRead = vi
        .spyOn(reportStorage, "readSessionTranscriptReportReceipts")
        .mockImplementation(async (...args) => {
          const lane = foreground.getStore() ? reads.foreground : reads.background;
          lane.observe++;
          lane.observePending++;
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
            lane.observePending--;
            lane.observeMs += performance.now() - started;
          }
        });
      let prefetch: ReturnType<typeof prepareConversationKnowledgeRecipient>;
      let releaseKnowledge = () => {};
      inspectFailure = () => ({
        spans,
        reads,
        prefetchRegistered: Boolean(prefetch),
        cacheRevision: prefetch?.cache.revision,
        preparedRoot: Boolean(prefetch?.cache.preparedRoot),
        preparedCheckpoint: Boolean(prefetch?.cache.preparedCheckpoint),
        compactionCalls: budget.compact.mock.calls.length,
      });
      budget.compact.mockClear();
      try {
        mark("setup:create-three-native-branches");
        const chat = await fixture.branch("throughput-chat");
        const previousCall = await fixture.branch("throughput-prior-call");
        const recipient = await fixture.branch("throughput-recipient");
        const rootLifecycleRevision = loadSessionEntry(fixture.root)!.lifecycleRevision;
        const ledgerPacketIds = new Set(
          Array.from({ length: recipientLedgerEvents }, (_, index) => `ledger-packet-${index}`),
        );
        mark("setup:write-recipient-ledger");
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
        mark("setup:write-source-history");
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
        mark("setup:claim-original-sources");
        const chatClaim = await fixture.claim(chat);
        const previousCallClaim = await fixture.claim(previousCall);
        const markers = Array.from(
          { length: contributionCount },
          (_, index) => `CHAT_MARKER_${String(index).padStart(2, "0")}`,
        );
        for (const [index, marker] of markers.entries()) {
          mark(`setup:publish-source-${index}`);
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
        mark("setup:publish-prior-call");
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
        mark("setup:resolve-and-claim-recipient-writer");
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
        mark("background:register-recipient-and-root-owner");
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
        mark("background:wait-initial-prefetch");
        await prefetch.owner.wait();
        mark("background:initial-prefetch-finished");
        const firstPreparationMs = performance.now() - started;
        let livePublicationMs = 0;
        if (simulation) {
          // The live recipient is already idle/open. New commits alone must
          // prepare fresh facts behind its backlog, without a user/model turn.
          const publishedAt = performance.now();
          for (let live = 0; live < 6; live++) {
            mark(`background:publish-live-${live}`);
            const index = markers.length;
            const marker = `CHAT_MARKER_${String(index).padStart(2, "0")}`;
            markers.push(marker);
            const terminal = await fixture.append(
              chat,
              `throughput-chat-${index}`,
              "stop",
              `A newly published observation during an open conversation: ${marker}.`,
            );
            expect(
              await recordConversationKnowledgeTurn({
                ...chatClaim,
                ...terminal,
                privateAudience: { participant: person, admission: terminal.admission! },
              }),
            ).toBe(true);
          }
          livePublicationMs = performance.now() - publishedAt;
          mark("background:wait-live-prefetch");
          await prefetch.owner.wait();
        }
        const preparationMs = performance.now() - started - livePublicationMs;
        mark("verify:idle-preparation");
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
        mark("verify:rebind-prepared-root");
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
        expect(readyContributions).toEqual(expectedContributions);
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
        mark("foreground:prepare-native-turn");
        await knowledge.prepare(admission, signal);
        mark("foreground:prepare-native-history");
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
        const admit = (context: object = contextIdentity) =>
          foreground.run(true, () =>
            withSessionTranscriptWriteAssertion(writer, recipientClaim.assertCurrent, () =>
              knowledge.refreshPrepared({
                signal,
                contextIdentity: context,
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
        const boundaryTrace: Array<{
          boundary: number;
          newDurable: number;
          durable: number;
          staged: number;
          overlap: number;
          examples: Array<{ contributionId: string; offset: number }>;
        }> = [];
        const reportDiagnostic = (checkpoint: string) => {
          if (!simulation) {
            return;
          }
          console.info(
            JSON.stringify({
              benchmark: "recipient-readiness-and-native-consumption",
              checkpoint,
              historyEvents,
              recipientLedgerEvents,
              contributions: markers.length + 1,
              packets: packets.length,
              sources: 2,
              observationRepeat,
              nativeBatchCalls: batch.mock.calls.length,
              compactionCalls: budget.compact.mock.calls.length,
              setupMs,
              preparationMs,
              firstPreparationMs,
              livePublicationMs,
              idleLiveContributions: simulation ? 6 : 0,
              idlePreparedPackets,
              idlePreparedBytes,
              immediatelyProvenContributions: readyContributions.size,
              boundaryCount,
              boundaryTrace,
              admissionMs,
              maxAdmissionMs,
              continuationWaitMs,
              reads,
              spans,
              timingSemantics:
                "inclusive nested spans; report phase spans cover append owners only; reportExecute includes native admission/IPC/SQL; reportBeforeCallback includes source preparation/binding; reportAfterCallback includes settlement/cleanup; outsideRefresh includes setup and detached preparation; do not sum overlapping owners",
              harnessRssBefore: rssBefore,
              harnessRssAfter: process.memoryUsage().rss,
              processLifetimePeakRssKiB: process.resourceUsage().maxRSS,
              mocked: "model compaction module, expected never called",
              real: "SQLite, compiled workers, source authority, bounded read-ahead, actual knowledge-turn boundaries and owner wakeups, native request capacity, exact packet receipts and admitted writer",
              modelPreparationCoveredSeparately: true,
              serverLatencyAcceptance: false,
            }),
          );
        };
        for (; boundaryCount < 512; boundaryCount++) {
          mark(`foreground:admit-boundary-${boundaryCount}`);
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
          mark(`background:wait-after-boundary-${boundaryCount}`);
          await prefetch.owner.wait();
          continuationWaitMs += performance.now() - waitStarted;
          packets = await readPackets();
          const committed = new Set(
            packets.map((packet) => {
              const details = asOptionalRecord(packet!.details);
              if (
                typeof details?.contributionId !== "string" ||
                !Number.isSafeInteger(details.offset)
              ) {
                throw new Error("Expected exact native durable packet identity");
              }
              return JSON.stringify([details.contributionId, details.offset]);
            }),
          );
          const staged = prefetch.cache.preparedPackets(Number.MAX_SAFE_INTEGER);
          const overlap = staged.filter((slot) =>
            committed.has(JSON.stringify([slot.contributionId, slot.offset])),
          );
          if (boundaryTrace.length < 32) {
            boundaryTrace.push({
              boundary: boundaryCount + 1,
              newDurable: packets.length - previousPacketCount,
              durable: packets.length,
              staged: staged.length,
              overlap: overlap.length,
              examples: overlap.slice(0, 4),
            });
          }
          if (overlap.length) {
            reportDiagnostic("accepted-slot-restaged");
          }
          expect(
            overlap.length,
            "drained background work must not restage a durably admitted slot",
          ).toBe(0);
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
        mark("verify:native-drain");
        reportDiagnostic("after-native-drain");
        expect(
          boundaryCount,
          "all contributions must finish through bounded native boundaries",
        ).toBeLessThan(512);
        expect(
          boundaryCount,
          "fully staged data fitting the native token budget must drain at one model boundary",
        ).toBe(1);
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
              // This scenario creates new carriers; legacy byte preservation is
              // independently covered by conversation-knowledge-packets.test.ts.
              return packet!.content
                .split("\n")
                .slice(2)
                .map((line) => {
                  const match = /^(?:user|assistant): (.+)$/.exec(line);
                  if (!match) {
                    throw new Error("Expected native quoted observation role");
                  }
                  const observationText: unknown = JSON.parse(match[1]!);
                  if (typeof observationText !== "string") {
                    throw new Error("Expected native observation text");
                  }
                  return observationText;
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
          batch.mock.calls.every(
            ([, entries]) =>
              entries.length > 0 && entries.length <= MAX_TRANSCRIPT_REPORT_BATCH_SIZE,
          ),
        ).toBe(true);
        expect(reads.foreground.root).toBe(0);
        expect(reads.foreground.progress).toBe(0);
        expect(reads.foreground.observe).toBeGreaterThan(0);
        expect(reads.foreground.maxObserveQueries).toBeLessThanOrEqual(
          MAX_TRANSCRIPT_REPORT_BATCH_SIZE,
        );
        expect(reads.foreground.missing).toBeGreaterThanOrEqual(packets.length);
        mark("foreground:retry-identical-context");
        await admit();
        expect(batch).toHaveBeenCalledTimes(batchCalls);
        mark("foreground:retry-new-context");
        const retryPackets = await admit({});
        expect(retryPackets).toHaveLength(packets.length);
        expect(
          new Set(retryPackets.map((packet) => asOptionalRecord(packet.details)?.packetId)).size,
        ).toBe(packets.length);
        expect(batch).toHaveBeenCalledTimes(batchCalls);
        expect(budget.compact).not.toHaveBeenCalled();
        expect(await fixture.receipts()).toEqual(receipts);
        expect(
          (await loadTranscriptEvents(recipient))
            .map(asOptionalRecord)
            .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT),
        ).toHaveLength(recipientLedgerEvents + packets.length);
      } finally {
        mark("cleanup:release-turn-and-spies");
        releaseKnowledge();
        batch.mockRestore();
        rootRead.mockRestore();
        progressRead.mockRestore();
        observeRead.mockRestore();
        grantRead.mockRestore();
        factsRead.mockRestore();
        anchorRead.mockRestore();
        reportWorker.mockRestore();
        reportSource.mockRestore();
        reportAccepted.mockRestore();
        mark("cleanup:close-prefetch-and-root-owner");
        await prefetch?.owner.close();
        mark("cleanup:close-native-fixture");
        await fixture.close();
        mark("cleanup:fixture-closed");
      }
    },
  );
  mark("complete");
});
