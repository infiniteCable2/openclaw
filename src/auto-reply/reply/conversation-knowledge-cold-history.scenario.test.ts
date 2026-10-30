import "../../test-utils/prepare-compiled-subprocesses.js";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { createConversationContextCapacity } from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
} from "../../config/sessions/conversation-knowledge-packets.js";
import * as knowledgePackets from "../../config/sessions/conversation-knowledge-packets.js";
import * as knowledgeSeed from "../../config/sessions/conversation-knowledge-seed.js";
import {
  readConversationKnowledgeBranch,
  recordConversationUtteranceObservation,
} from "../../config/sessions/conversation-knowledge-store.js";
import {
  CONVERSATION_UTTERANCE_REPORT,
  readConversationUtteranceObservation,
} from "../../config/sessions/conversation-knowledge.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as reportStorage from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createConversationKnowledgeBoundaryProfiler } from "./conversation-knowledge-boundary-profile.test-support.js";
import { registerConversationKnowledgeCheckpointOwner } from "./conversation-knowledge-checkpoint-owner.js";
import { prepareRecipientConversationProjection } from "./conversation-knowledge-checkpoint-recipient.js";
import { prepareConversationKnowledgeRecipient } from "./conversation-knowledge-prefetch.js";
import { createReplyConversationKnowledgeTurn } from "./conversation-knowledge-turn.js";
import * as knowledgePreparation from "./conversation-knowledge.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";
import { lifecycleAdmissionByOperation } from "./reply-run-registry.state.js";
import { createMockFollowupRun, createMockReplyOperation } from "./test-helpers.js";

const model = vi.hoisted(() => ({ summarize: vi.fn(), compact: vi.fn() }));
// Actual SQLite, compiled workers, root publication, shared projection, private
// read grants, recipient preparation and native packet commits are not mocked.
// mock-isolation: Supply a fixed large model budget without credentials, network calls or synthesis.
vi.mock("./conversation-knowledge-checkpoint-model.js", () => ({
  acquireConversationKnowledgeCheckpointModel: async () => ({
    planning: {
      budget: { contextTokenBudget: 1_000_000, prompt: "" },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 16_384 },
    },
    summarize: model.summarize,
    async [Symbol.asyncDispose]() {},
  }),
}));
// mock-isolation: The native model-boundary capacity check must not initiate model compaction.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: model.compact,
}));

const marker = (donor: number, index: number) =>
  `SYNTH_ORIGINAL_${String(donor).padStart(2, "0")}_${String(index).padStart(2, "0")}`;
const countMarkers = (messages: unknown) =>
  new Set(JSON.stringify(messages).match(/SYNTH_ORIGINAL_\d+_\d+/gu) ?? []).size;

it.for([
  {
    label: "15 originals across 3 donors",
    donorCount: 3,
    originalsPerDonor: 5,
    settledWriter: false,
  },
  {
    label: "450 originals across 30 donors",
    donorCount: 30,
    originalsPerDonor: 15,
    settledWriter: false,
  },
  {
    label: "settled writer across 3 donors",
    donorCount: 3,
    originalsPerDonor: 5,
    settledWriter: true,
  },
])(
  "$label: exposes cold partial-manifest and reused idle-admission gaps",
  async ({ label, donorCount, originalsPerDonor, settledWriter }, { signal }) => {
    const originalCount = donorCount * originalsPerDonor;
    model.summarize.mockClear();
    model.compact.mockClear();
    const started = performance.now();
    const cpu = process.cpuUsage();
    let phase = "setup";
    const stages: Array<Record<string, string | number | boolean>> = [];
    const preparationFailures: Array<{ name: string; message: string }> = [];
    const preparationOutcomes: Array<Record<string, boolean | number>> = [];
    const nativeBatchSizes: number[] = [];
    const boundaryProfile = createConversationKnowledgeBoundaryProfiler();
    const retainPackets = knowledgePackets.retainConversationKnowledgePackets;
    const retention = vi
      .spyOn(knowledgePackets, "retainConversationKnowledgePackets")
      .mockImplementation((params) => {
        nativeBatchSizes.push(params.packets.length);
        return boundaryProfile.observe("nativePacketRetention", () => retainPackets(params));
      });
    onTestFinished(() => retention.mockRestore());
    const mark = (stage: string, counts: Record<string, number | boolean> = {}) => {
      phase = stage;
      stages.push({ stage, elapsedMs: Math.round(performance.now() - started), ...counts });
    };
    try {
      await withOpenClawTestState(
        { scenario: "minimal", label: "knowledge-cold-history-simulation" },
        async (state) => {
          const fixture = await createConversationKnowledgeScenario(state);
          fixture.cfg.agents!.defaults = { model: { primary: "synthetic/cold-model" } };
          fixture.cfg.models = {
            providers: {
              synthetic: {
                baseUrl: "https://model.example.invalid",
                api: "openai-completions",
                models: [
                  {
                    id: "cold-model",
                    name: "Synthetic context budget",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 1_000_000,
                    maxTokens: 16_384,
                  },
                ],
              },
            },
          };
          await state.writeConfig(fixture.cfg);
          let checkpoint:
            | ReturnType<typeof registerConversationKnowledgeCheckpointOwner>
            | undefined;
          let recipient: ReturnType<typeof prepareConversationKnowledgeRecipient>;
          let releaseTurn = () => {};
          let resumeRecipient = () => {};
          const closeOwners = async () => {
            const failures: unknown[] = [];
            const operations: Array<() => void | Promise<void>> = [
              () => releaseTurn(),
              () => resumeRecipient(),
              () => recipient?.owner.close(),
              () => checkpoint?.close(),
              () => fixture.close(),
            ];
            for (const close of operations) {
              try {
                await Promise.resolve(close());
              } catch (error) {
                failures.push(error);
              }
            }
            if (failures.length) {
              throw new AggregateError(failures, "Cold-history simulation cleanup remains pending");
            }
          };
          try {
            const donors: Array<{
              target: Awaited<ReturnType<typeof fixture.branch>>;
              owner: Awaited<ReturnType<typeof fixture.claim>>;
            }> = [];
            for (let donor = 0; donor < donorCount; donor++) {
              signal.throwIfAborted();
              const target = await fixture.branch(`cold-donor-${donor}`);
              const events = Array.from({ length: originalsPerDonor }, (_, index) => ({
                type: "message",
                id: `original-${donor}-${index}`,
                parentId: index === 0 ? null : `original-${donor}-${index - 1}`,
                message: {
                  role: "user",
                  content: `${marker(donor, index)}. ${"A complete synthetic observation. ".repeat(12)}`,
                  timestamp: Date.now() + index,
                },
              }));
              await replaceTranscriptEvents(target, [
                { type: "session", id: target.sessionId, version: CURRENT_SESSION_VERSION },
                ...events,
              ]);
              const owner = await fixture.claim(target);
              const facts = await readSessionTranscriptAnchorsAsync(
                target,
                { entryIds: events.map((event) => event.id) },
                signal,
              );
              expect(facts.anchors).toHaveLength(originalsPerDonor);
              for (const anchor of facts.anchors) {
                signal.throwIfAborted();
                expect(
                  await recordConversationUtteranceObservation({
                    ...owner,
                    anchor,
                    role: "user",
                    privateAudience: { participant: person, admission: anchor },
                  }),
                ).toBe(true);
              }
              donors.push({ target, owner });
            }
            const references = (await loadTranscriptEvents(fixture.root)).flatMap((event) => {
              const row = asOptionalRecord(event);
              const reference =
                row?.customType === CONVERSATION_UTTERANCE_REPORT
                  ? readConversationUtteranceObservation(row.details)
                  : undefined;
              return reference ? [reference] : [];
            });
            expect(references).toHaveLength(originalCount);
            mark("originals-published", { donors: donorCount, originals: references.length });

            // A separate admitted private broker keeps the shared root projection
            // warm before the cold recipient exists. The root owner itself is real.
            const keeper = await fixture.branch("warm-root-broker");
            const keeperOwner = await fixture.claim(keeper);
            const keeperBranch = await readConversationKnowledgeBranch(keeperOwner);
            if (!keeperBranch) {
              throw new Error("Expected real root broker enrollment");
            }
            const rootReady = createDeferredCore();
            checkpoint = registerConversationKnowledgeCheckpointOwner({
              branch: keeperBranch,
              participant: person,
              audience: {
                agentId: keeper.agentId,
                sessionKey: keeper.sessionKey,
                channelId: "test",
                accountId: "default",
                nativeChannelId: "synthetic-root-broker",
                participant: person,
                assertCurrent: keeperOwner.assertCurrent,
              },
              env: state.env,
              getRuntimeConfig: () => fixture.cfg,
              onReady() {
                if (checkpoint?.projection().tail.length === originalCount) {
                  rootReady.resolve();
                }
              },
            });
            await withinTest(rootReady.promise, signal);
            const projection = checkpoint.projection();
            expect(projection.tail).toHaveLength(originalCount);
            expect(countMarkers(projection.tail.map((item) => item.packet.part.text))).toBe(
              originalCount,
            );
            expect(projection.checkpoint).toBeUndefined();
            mark("shared-root-ready", { prepared: projection.tail.length });

            const target = await fixture.branch("cold-recipient");
            await replaceTranscriptEvents(target, [
              { type: "session", id: target.sessionId, version: CURRENT_SESSION_VERSION },
            ]);
            const nativeTarget = await resolveAgentRunSessionTarget({
              ...target,
              sessionTarget: target,
              config: fixture.cfg,
              missingSessionKey: "resolve-existing",
            });
            expect(nativeTarget.storePath).toBe(target.storePath);
            expect(nativeTarget.sessionId).toBe(target.sessionId);
            const runId = "synthetic-cold-recipient-run";
            const writer = {
              ...nativeTarget,
              expectedLifecycleRevision: target.lifecycleRevision,
              expectedWriterRunId: runId,
            };
            await upsertSessionEntryCore(target, {
              ...loadSessionEntry(target)!,
              activeWriterRunId: runId,
            });
            const owner = await fixture.claim(target);
            const branch = await readConversationKnowledgeBranch(owner);
            if (!branch) {
              throw new Error("Expected real cold-recipient enrollment");
            }
            const audience: ConversationPrivateAudience = {
              agentId: target.agentId,
              sessionKey: target.sessionKey,
              channelId: "test",
              accountId: "default",
              nativeChannelId: "synthetic-cold-recipient",
              participant: person,
              assertCurrent: owner.assertCurrent,
            };
            recipient = prepareConversationKnowledgeRecipient({
              branch,
              participant: person,
              audience,
              env: state.env,
              getRuntimeConfig: () => fixture.cfg,
            });
            if (!recipient) {
              throw new Error("Expected native recipient preparation owner");
            }
            // Hold only recipient read-ahead while one real source quantum creates
            // the partial native manifest. No storage, grant or projection is faked.
            resumeRecipient = recipient.owner.pausePreparation();
            const partial = await knowledgePreparation.prepareReplyConversationKnowledge({
              ...owner,
              originalParticipant: person,
              destinationAudience: audience,
              getRuntimeConfig: () => fixture.cfg,
              signal,
              sourceCache: recipient.cache,
              preparationOnly: true,
              sourceBudget: 1,
              sourceCursor: conversationKnowledgeContributionId(projection.tail.at(-1)!.reference),
            });
            partial?.release();
            expect(recipient.cache.preparedPackets(originalCount + 1)).toHaveLength(1);
            expect(recipient.cache.preparedRoot).toBeDefined();
            await prepareRecipientConversationProjection(
              {
                ...owner,
                originalParticipant: person,
                destinationAudience: audience,
                expectedAudienceIdentity: projection.audienceKey,
                getRuntimeConfig: () => fixture.cfg,
                signal,
                sourceCache: recipient.cache,
              },
              projection.tail,
            );
            const preparedAfterBorrow = recipient.cache.preparedPackets(originalCount + 1).length;
            mark("shared-tail-borrowed", {
              prepared: preparedAfterBorrow,
              expected: originalCount,
            });
            // Desired regression: a partial recipient manifest must not suppress
            // already complete, currently authorized shared projection material.
            expect.soft(preparedAfterBorrow).toBe(originalCount);

            const { replyOperation } = createMockReplyOperation({
              key: target.sessionKey,
              sessionId: target.sessionId,
            });
            lifecycleAdmissionByOperation.set(replyOperation, { reader: owner.reader });
            const followupRun = createMockFollowupRun({
              conversationParticipant: person,
              conversationAudience: audience,
              run: {
                ...nativeTarget,
                config: fixture.cfg,
                provider: "synthetic",
                model: "cold-model",
              },
            });
            const admission = prepareAgentRunAdmission({
              cfg: fixture.cfg,
              operationalRunInstance: createOperationalRunInstanceRef(runId),
              assertSourceCurrent: owner.assertCurrent,
              facts: {
                runId,
                agentId: target.agentId,
                ingress: {
                  kind: "channel",
                  boundary: "knowledge-cold-history-test",
                  state: "present",
                },
              },
            });
            releaseTurn = () => {
              admission.close();
              lifecycleAdmissionByOperation.delete(replyOperation);
            };
            const knowledge = createReplyConversationKnowledgeTurn({
              turn: { isHeartbeat: false, followupRun, replyOperation },
              originalSource: owner.assertCurrent,
              getRuntimeConfig: () => fixture.cfg,
            });
            if (!knowledge) {
              throw new Error("Expected real knowledge-turn admission");
            }
            releaseTurn = () => {
              try {
                knowledge.release();
              } finally {
                admission.close();
                lifecycleAdmissionByOperation.delete(replyOperation);
              }
            };
            const seed = vi.spyOn(knowledgeSeed, "ensureConversationKnowledgeSeed");
            const prepare = knowledgePreparation.prepareReplyConversationKnowledge;
            const preparation = vi
              .spyOn(knowledgePreparation, "prepareReplyConversationKnowledge")
              .mockImplementation(async (input) => {
                try {
                  const value = await boundaryProfile.observe("knowledgePreparation", () =>
                    prepare(input),
                  );
                  preparationOutcomes.push({
                    readyOnly: input.readyOnly === true,
                    retainInHistory: Boolean(input.retainInHistory),
                    prepared: Boolean(value),
                    pending: value?.pendingPackets === true,
                  });
                  return value;
                } catch (error) {
                  preparationFailures.push({
                    name: error instanceof Error ? error.name : "unknown",
                    message: error instanceof Error ? error.message : "non-error failure",
                  });
                  throw error;
                }
              });
            onTestFinished(() => {
              preparation.mockRestore();
              seed.mockRestore();
            });
            await knowledge.prepare(admission, signal);
            const seedResult = seed.mock.results[0];
            if (!seedResult) {
              throw new Error("Expected native seed preparation before the model boundary");
            }
            expect((await seedResult.value).status).not.toBe("pending");
            await withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
              knowledge.prepareHistory({
                ...followupRun.run,
                runId,
                prompt: "Recall the synthetic observations.",
                sessionTarget: writer,
                contextTokenBudget: 1_000_000,
              }),
            );
            const messages: unknown[] = [];
            const refresh = () =>
              withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
                knowledge.refreshPrepared({
                  signal,
                  canAdmit: createConversationContextCapacity({
                    messages: [],
                    contextWindow: 1_000_000,
                    reserveTokens: 16_384,
                  }),
                }),
              );
            const boundaryBegan = performance.now();
            const firstBoundary = await boundaryProfile.measure(target.sessionId, refresh);
            messages.push(...convertToLlm(firstBoundary));
            mark("first-model-boundary", {
              admitted: firstBoundary.length,
              prospectiveModelOriginals: countMarkers(messages),
              boundaryMs: Math.round(performance.now() - boundaryBegan),
            });
            expect.soft(countMarkers(messages)).toBe(originalCount);
            // Each donor spans at most two native 32-packet quanta here. The
            // fast path must rebind its prepared group, not reread every original.
            const authorityCalls = boundaryProfile.snapshot().readAuthority?.calls ?? 0;
            expect(authorityCalls).toBeGreaterThan(0);
            expect(authorityCalls).toBeLessThanOrEqual(donorCount * 2);
            expect(
              firstBoundary.map((message) => asOptionalRecord(message.details)?.contributionId),
            ).toEqual(
              projection.tail.map(({ reference }) =>
                conversationKnowledgeContributionId(reference),
              ),
            );
            expect(Math.max(...nativeBatchSizes)).toBeGreaterThan(1);

            resumeRecipient();
            resumeRecipient = () => {};
            await withinTest(recipient.owner.wait(), signal);
            mark("remaining-background-ready", recipient.cache.diagnosticCapacity());
            const secondBoundary = await refresh();
            messages.push(...convertToLlm(secondBoundary));
            const packets = async () =>
              (await loadTranscriptEvents(target)).flatMap((event) => {
                const row = asOptionalRecord(event);
                const details = asOptionalRecord(row?.details);
                return row?.customType === CONVERSATION_KNOWLEDGE_CONTEXT &&
                  typeof details?.contributionId === "string"
                  ? [details.contributionId]
                  : [];
              });
            const retained = await packets();
            expect(new Set(retained).size).toBe(originalCount);
            expect(retained).toHaveLength(originalCount);
            expect(countMarkers(messages)).toBe(originalCount);
            mark("full-history-admitted", { admitted: retained.length });
            releaseTurn();
            releaseTurn = () => {};
            await upsertSessionEntryCore(target, {
              ...loadSessionEntry(target)!,
              // Native completion keeps the writer fence. Cover that actual row
              // shape as well as metadata-only recipients with no previous run.
              activeWriterRunId: settledWriter
                ? loadSessionEntry(target)!.activeWriterRunId
                : undefined,
              status: "done",
            });
            await withinTest(recipient.owner.wait(), signal);
            mark("idle-baseline-settled", { admitted: (await packets()).length });

            // The small case also races a real SDK append against the first idle
            // COMMIT. Recovery must restage itself without a new user/model turn.
            let idleVersionRaced = false;
            const interveningText = "Synthetic SDK input during idle admission.";
            if (donorCount === 3) {
              const nativeAppend = reportStorage.appendSessionTranscriptReportBatch;
              const race = vi
                .spyOn(reportStorage, "appendSessionTranscriptReportBatch")
                .mockImplementation((scope, reports, options) => {
                  const source = options?.source;
                  if (
                    !source?.prepareSessionSource ||
                    !reports.every(
                      (report) => report.report.customType === CONVERSATION_KNOWLEDGE_CONTEXT,
                    )
                  ) {
                    return nativeAppend(scope, reports, options);
                  }
                  const guarded: SessionSourceAssertion = Object.assign(() => source(), {
                    async prepareSessionSource() {
                      const prepared = await source.prepareSessionSource!();
                      if (!idleVersionRaced) {
                        idleVersionRaced = true;
                        await withSessionTranscriptWriteAssertion(
                          { ...target, expectedLifecycleRevision: target.lifecycleRevision },
                          owner.assertCurrent,
                          () =>
                            appendTranscriptMessage(target, {
                              message: {
                                role: "user",
                                content: interveningText,
                                timestamp: Date.now(),
                              },
                            }),
                        );
                      }
                      return prepared;
                    },
                  });
                  return nativeAppend(scope, reports, { ...options, source: guarded });
                });
              onTestFinished(() => race.mockRestore());
            }
            // Reuse the same idle recipient. Only committed source observations
            // trigger its existing background owners; no synthetic user turn runs.
            const liveIds: string[] = [];
            for (const [index, donor] of donors.slice(0, 2).entries()) {
              signal.throwIfAborted();
              const saved = await appendTranscriptMessage(donor.target, {
                message: {
                  role: "user",
                  content: `Idle live observation ${index}.`,
                  timestamp: Date.now(),
                },
              });
              if (!saved.anchor) {
                throw new Error("Expected real live-source anchor");
              }
              await recordConversationUtteranceObservation({
                ...donor.owner,
                anchor: saved.anchor,
                role: "user",
                privateAudience: { participant: person, admission: saved.anchor },
              });
              const reference = (await loadTranscriptEvents(fixture.root)).flatMap((event) => {
                const row = asOptionalRecord(event);
                const observation =
                  row?.customType === CONVERSATION_UTTERANCE_REPORT
                    ? readConversationUtteranceObservation(row.details)
                    : undefined;
                return observation?.through.entryId === saved.anchor!.entryId ? [observation] : [];
              })[0];
              if (!reference) {
                throw new Error("Expected native live-source publication");
              }
              liveIds.push(conversationKnowledgeContributionId(reference));
            }
            await withinTest(recipient.owner.wait(), signal);
            const preparedLive = liveIds.filter(
              (id) => recipient!.cache.peek(id, 0)?.part.complete,
            ).length;
            const retainedAfterIdle = new Set(await packets());
            const admittedLive = liveIds.filter((id) => retainedAfterIdle.has(id)).length;
            mark("reused-idle-recipient", {
              prepared: preparedLive,
              admitted: admittedLive,
              expected: 2,
            });
            expect(preparedLive).toBe(0);
            // Desired regression: existing silent recipients need an idle native
            // admission point; readiness alone is not completed synchronization.
            expect.soft(admittedLive).toBe(2);
            if (donorCount === 3) {
              expect(idleVersionRaced).toBe(true);
              const matching = (await loadTranscriptEvents(target)).filter((event) => {
                const message = asOptionalRecord(asOptionalRecord(event)?.message);
                return message?.role === "user" && message.content === interveningText;
              });
              expect(matching).toHaveLength(1);
            }
            expect(model.compact).not.toHaveBeenCalled();
            expect(model.summarize).not.toHaveBeenCalled();
          } finally {
            await closeOwners();
          }
        },
      );
    } finally {
      console.info(
        JSON.stringify({
          scenario: "cold-history-and-idle-recipient",
          case: label,
          donorCount,
          originalCount,
          phase,
          stages,
          preparationFailures,
          preparationOutcomes,
          nativeBatchSizes,
          firstBoundaryTimings: boundaryProfile.snapshot(),
          timingMeaning:
            "Pass-through first refresh window; inclusive nested/background timings can overlap and are not additive; no native result or error substituted.",
          elapsedMs: Math.round(performance.now() - started),
          cpuMicroseconds: process.cpuUsage(cpu),
          processLifetimePeakRssKiB: process.resourceUsage().maxRSS,
          resourceMeaning:
            "CPU is this process during the case; maxRSS is this process lifetime, not aggregate compiled-worker usage",
          real: "SQLite, compiled workers, original source publication, private authority, root projection, recipient prefetch, knowledge-turn admission and model-boundary message conversion",
          substituted:
            "host-ingress fixture, fixed model planning budget; no provider, channel transport or audio invocation",
          modelInputMeaning:
            "prospective payload returned by native refreshPrepared and convertToLlm; no model was called",
        }),
      );
    }
  },
);
