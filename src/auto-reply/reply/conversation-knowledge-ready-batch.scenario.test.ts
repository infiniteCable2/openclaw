import "../../test-utils/prepare-compiled-subprocesses.js";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { CONVERSATION_KNOWLEDGE_CONTEXT } from "../../config/sessions/conversation-knowledge-packets.js";
import { recordConversationUtteranceObservation } from "../../config/sessions/conversation-knowledge-store.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as reportStorage from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { MAX_TRANSCRIPT_REPORT_BATCH_SIZE } from "../../config/sessions/session-accessor.sqlite-transcript-reports.types.js";
import {
  addSessionMemberInWorker,
  removeSessionMemberInWorker,
} from "../../config/sessions/session-sharing-store.async.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";

// SQLite, compiled workers, source projection, private grants and batch COMMIT
// remain real. The delegating spy changes donor membership or the recipient
// transcript after predicates are prepared; it never fakes a successful write.
it.for([
  { label: "donor revocation", count: MAX_TRANSCRIPT_REPORT_BATCH_SIZE, race: "donor" },
  { label: "recipient transcript change", count: 2, race: "recipient" },
  { label: "an existing middle carrier", count: 3, race: "existing" },
] as const)(
  "refuses a ready batch after $label and retries its exact originals",
  async ({ count, race }, { signal }) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "knowledge-ready-batch-revocation" },
      async (state) => {
        const fixture = await createConversationKnowledgeScenario(state);
        const cache = createConversationKnowledgeSourceCache();
        let auxiliaryCache: ReturnType<typeof createConversationKnowledgeSourceCache> | undefined;
        let closed = false;
        const close = async () => {
          if (!closed) {
            cache.clear();
            auxiliaryCache?.clear();
            await fixture.close();
            closed = true;
          }
        };
        onTestFinished(close);
        try {
          const donors: Array<Awaited<ReturnType<typeof fixture.branch>>> = [];
          const donorCount = race === "existing" ? 1 : 2;
          const perDonor = count / donorCount;
          for (let donorIndex = 0; donorIndex < donorCount; donorIndex++) {
            const donor = await fixture.branch(`ready-batch-donor-${donorIndex}`);
            const messages = Array.from({ length: perDonor }, (_, index) => ({
              type: "message",
              id: `donor-${donorIndex}-original-${index}`,
              parentId: index ? `donor-${donorIndex}-original-${index - 1}` : null,
              message: {
                role: "user",
                content: `Synthetic original ${donorIndex}/${index}.`,
                timestamp: Date.now() + index,
              },
            }));
            await replaceTranscriptEvents(donor, [
              { type: "session", id: donor.sessionId, version: CURRENT_SESSION_VERSION },
              ...messages,
            ]);
            const owner = await fixture.claim(donor);
            const anchors = await readSessionTranscriptAnchorsAsync(
              donor,
              { entryIds: messages.map((message) => message.id) },
              signal,
            );
            expect(anchors.anchors).toHaveLength(perDonor);
            for (const anchor of anchors.anchors) {
              expect(
                await recordConversationUtteranceObservation({
                  ...owner,
                  role: "user",
                  anchor,
                  privateAudience: { participant: person, admission: anchor },
                }),
              ).toBe(true);
            }
            donors.push(donor);
          }
          const target = await fixture.branch("ready-batch-recipient");
          await replaceTranscriptEvents(target, [
            { type: "session", id: target.sessionId, version: CURRENT_SESSION_VERSION },
          ]);
          const runId = "synthetic-ready-batch-run";
          await upsertSessionEntryCore(target, {
            ...loadSessionEntry(target)!,
            activeWriterRunId: runId,
          });
          const writer = {
            ...target,
            expectedLifecycleRevision: target.lifecycleRevision,
            expectedWriterRunId: runId,
          };
          const owner = await fixture.claim(target);
          const audience: ConversationPrivateAudience = {
            agentId: target.agentId,
            sessionKey: target.sessionKey,
            channelId: "test",
            accountId: "example",
            nativeChannelId: "synthetic-ready-batch-recipient",
            participant: person,
            assertCurrent: owner.assertCurrent,
          };
          const common = {
            ...owner,
            originalParticipant: person,
            destinationAudience: audience,
            getRuntimeConfig: () => fixture.cfg,
            sourceCache: cache,
            signal,
          };
          const prepare = async () => {
            const prepared = await prepareReplyConversationKnowledge({
              ...common,
              preparationOnly: true,
            });
            prepared?.release();
          };
          await prepare();
          expect(cache.preparedPackets(MAX_TRANSCRIPT_REPORT_BATCH_SIZE + 1)).toHaveLength(count);
          const readPackets = async () =>
            (await loadTranscriptEvents(target)).flatMap((event) => {
              const row = asOptionalRecord(event);
              const details = asOptionalRecord(row?.details);
              return row?.customType === CONVERSATION_KNOWLEDGE_CONTEXT &&
                typeof details?.packetId === "string"
                ? [details.packetId]
                : [];
            });
          const consume = async (sourceCache = cache) => {
            // This is the actual native recipient version observed before the
            // positive prospective-budget decision, not a fabricated CAS token.
            const observed = await readSessionTranscriptAnchorsAsync(
              target,
              { entryIds: [], includeContextVersion: true },
              signal,
            );
            if (!observed.contextVersion) {
              throw new Error("Expected the native recipient context version");
            }
            const prepared = await withSessionTranscriptWriteAssertion(
              writer,
              owner.assertCurrent,
              () =>
                prepareReplyConversationKnowledge({
                  ...common,
                  sourceCache,
                  readyOnly: true,
                  retainInHistory: {
                    writeTarget: writer,
                    ...(race !== "donor"
                      ? { expectedTranscriptVersion: observed.contextVersion }
                      : {}),
                    contextLimits: { maxBytes: 4 * 1024 * 1024, maxEvents: 1_000 },
                    maintainContext: async (sources) => {
                      sources();
                      return { compacted: false, complete: true, canAdmitPending: true };
                    },
                  },
                }),
            );
            prepared?.release();
            return prepared;
          };
          if (race === "existing") {
            // A second, independent native preparation copies only the middle
            // original. The first cache still contains all three candidates.
            auxiliaryCache = createConversationKnowledgeSourceCache();
            const middle = cache.preparedContributionIds(count)[1]!;
            const prepared = await prepareReplyConversationKnowledge({
              ...common,
              sourceCache: auxiliaryCache,
              preparationOnly: true,
              sourceCursor: middle,
              sourceBudget: 1,
            });
            prepared?.release();
            expect(auxiliaryCache.preparedPackets(count)).toHaveLength(1);
            await consume(auxiliaryCache);
            expect(await readPackets()).toHaveLength(1);
            expect(cache.preparedPackets(count + 1)).toHaveLength(count);
          }
          const nativeAppend = reportStorage.appendSessionTranscriptReportBatch;
          const batchSizes: number[] = [];
          let changed = false;
          const foreignIdentity = "synthetic-other-reader";
          const interveningText = "A newly arrived user message must survive the stale projection.";
          const batch = vi
            .spyOn(reportStorage, "appendSessionTranscriptReportBatch")
            .mockImplementation((scope, reports, options) => {
              if (
                !reports.every(
                  (report) => report.report.customType === CONVERSATION_KNOWLEDGE_CONTEXT,
                )
              ) {
                return nativeAppend(scope, reports, options);
              }
              batchSizes.push(reports.length);
              const source = options?.source;
              if (!source?.prepareSessionSource) {
                throw new Error("Expected native prepared batch authority");
              }
              const guarded: SessionSourceAssertion = Object.assign(() => source(), {
                async prepareSessionSource() {
                  const prepared = await source.prepareSessionSource!();
                  if (!changed && race !== "existing") {
                    changed = true;
                    if (race === "donor") {
                      const result = await addSessionMemberInWorker(donors[1]!, {
                        identityId: foreignIdentity,
                        addedBy: "synthetic-owner",
                        expectedSessionId: donors[1]!.sessionId,
                      });
                      expect(result.inserted).toBe(true);
                    } else {
                      await withSessionTranscriptWriteAssertion(writer, owner.assertCurrent, () =>
                        appendTranscriptMessage(writer, {
                          message: {
                            role: "user",
                            content: interveningText,
                            timestamp: Date.now(),
                          },
                        }),
                      );
                    }
                  }
                  return prepared;
                },
              });
              return nativeAppend(scope, reports, { ...options, source: guarded });
            });
          onTestFinished(() => batch.mockRestore());
          const first = await consume();
          if (race === "existing") {
            expect(first?.pendingPackets).toBe(true);
            expect(batchSizes).toEqual([1]);
            expect(await readPackets()).toHaveLength(2);
            await consume();
            const retained = await readPackets();
            expect(retained).toHaveLength(count);
            expect(new Set(retained).size).toBe(count);
            expect(batchSizes).toEqual([1, 1]);
            expect(cache.preparedPackets(count)).toHaveLength(0);
            return;
          }
          expect(changed).toBe(true);
          expect(batchSizes).toEqual([count]);
          expect(await readPackets()).toEqual([]);
          if (race === "recipient") {
            const transcript = await loadTranscriptEvents(target);
            expect(JSON.stringify(transcript)).toContain(interveningText);
            expect(loadSessionEntry(target)?.activeWriterRunId).toBe(runId);
            expect(cache.preparedPackets(count + 1)).toHaveLength(count);
          }

          if (race === "donor") {
            await removeSessionMemberInWorker(
              donors[1]!,
              foreignIdentity,
              undefined,
              donors[1]!.sessionId,
            );
          }
          await prepare();
          await consume();
          const retained = await readPackets();
          expect(retained).toHaveLength(count);
          expect(new Set(retained).size).toBe(count);
          expect(batchSizes).toEqual([count, count]);
          if (race === "recipient") {
            const messages = (await loadTranscriptEvents(target)).flatMap((event) => {
              const message = asOptionalRecord(asOptionalRecord(event)?.message);
              return message?.role === "user" && message.content === interveningText
                ? [message]
                : [];
            });
            expect(messages).toHaveLength(1);
          }
        } finally {
          await close();
        }
      },
    );
  },
);
