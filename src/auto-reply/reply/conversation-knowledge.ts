import { isDeepStrictEqual } from "node:util";
import type { CustomMessage } from "../../agents/sessions/messages.js";
import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import {
  createConversationKnowledgePacketReport,
  conversationKnowledgeContributionId,
  readActiveConversationKnowledgePacketIds,
  retainConversationKnowledgePackets,
  type ConversationKnowledgePacketAdmission,
} from "../../config/sessions/conversation-knowledge-packets.js";
import { selectConversationKnowledgeReceipts } from "../../config/sessions/conversation-knowledge-selection.js";
import { recordConversationKnowledgeTurn } from "../../config/sessions/conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_NOTICE,
  combineConversationKnowledge,
  isConversationKnowledgeReferenceObserved,
  projectConversationKnowledge,
  renderConversationKnowledgePacketText,
} from "../../config/sessions/conversation-knowledge.js";
import { MAX_TRANSCRIPT_REPORT_BATCH_SIZE } from "../../config/sessions/session-accessor.sqlite-transcript-reports.types.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import { SessionMutationFactsUnavailableError } from "../../gateway/session-sharing-incognito.js";
import { unavailableConversationKnowledge } from "./conversation-knowledge-authority.js";
import { admitRecipientConversationCheckpoint } from "./conversation-knowledge-checkpoint-recipient.js";
import { createConversationKnowledgeIngestion } from "./conversation-knowledge-ingestion.js";
import {
  createConversationKnowledgeSourceReader,
  observePreparedConversationKnowledgePackets,
  publishPreparedConversationKnowledgeRoot,
  readConversationKnowledgeInputs,
  prepareConversationKnowledgeTarget,
  type ConversationKnowledgeHeldSource,
} from "./conversation-knowledge-source-reader.js";
import {
  createConversationKnowledgeGapCollector,
  logConversationKnowledgeDiagnostic,
  logConversationKnowledgeTransfer,
} from "./conversation-knowledge-status.js";
import type {
  PreparedReplyConversationKnowledge,
  ReplyConversationKnowledgeParams,
} from "./conversation-knowledge.types.js";

export { recordConversationKnowledgeTurn };

/** A root reference selects candidates, never grants access to another person's conversation. */
export async function prepareReplyConversationKnowledge(
  params: ReplyConversationKnowledgeParams,
): Promise<PreparedReplyConversationKnowledge | undefined> {
  const mode = resolveAgentConversationMode(
    params.getRuntimeConfig(),
    params.reader.logicalAgentId,
  );
  const assertCurrent = composeSessionSourceAssertion([params.assertCurrent], (check) => {
    check();
    if (
      resolveAgentConversationMode(params.getRuntimeConfig(), params.reader.logicalAgentId) !== mode
    ) {
      throw new Error("Conversation mode changed during context admission");
    }
  });
  return prepareReplyConversationKnowledgeInMode({ ...params, assertCurrent }, mode);
}

async function prepareReplyConversationKnowledgeInMode(
  params: ReplyConversationKnowledgeParams,
  mode: "native" | "branches",
): Promise<PreparedReplyConversationKnowledge | undefined> {
  params.assertCurrent();
  params.signal?.throwIfAborted();
  if (params.readyOnly && params.sourceCache?.preparedCheckpoint) {
    const bootstrap = await admitRecipientConversationCheckpoint(params);
    if (bootstrap) {
      return bootstrap;
    }
  }
  // Capture before source I/O so foreground consumption invalidates older disposable progress.
  const preparationConsumptionRevision = params.sourceCache?.consumptionRevision;
  const manifest = params.readyOnly ? params.sourceCache?.preparedRoot : undefined;
  if (params.readyOnly && !manifest) {
    return undefined;
  }
  const originalParticipant = params.originalParticipant
    ? structuredClone(params.originalParticipant)
    : undefined;
  const participantIdentity = conversationKnowledgeParticipantIdentity(originalParticipant);
  // An administrator's history scope is not permission for implicit disclosure.
  if (!originalParticipant || !participantIdentity) {
    return unavailableConversationKnowledge(params, "original-participant-unconfirmed");
  }
  const target = await prepareConversationKnowledgeTarget({ ...params, participantIdentity });
  if (!target) {
    return undefined;
  }
  if (target.kind === "unavailable") {
    return target.unavailable;
  }
  const { branch, targetFacts } = target;
  const reads: ConversationKnowledgeHeldSource[] = [];
  const drop = (read: (typeof reads)[number]) => {
    const index = reads.indexOf(read);
    if (index < 0) {
      return;
    }
    reads.splice(index, 1);
    read.grant.release();
  };
  const refusedSources = () =>
    reads.filter((held) => {
      try {
        held.grant.assertCurrent();
        return false;
      } catch (error) {
        if (error instanceof SessionMutationFactsUnavailableError && !params.readyOnly) {
          throw error;
        }
        return true;
      }
    });
  let active = true;
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    const failures: unknown[] = [];
    for (const read of reads.toReversed()) {
      try {
        drop(read);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      targetFacts.release();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(failures, "Conversation knowledge read cleanup failed");
    }
  };
  try {
    params.assertCurrent();
    targetFacts.assertCurrent();
    const inputs = await readConversationKnowledgeInputs({
      ...params,
      branch,
      manifest,
      retainInHistory: Boolean(params.retainInHistory),
      assertCurrent: composeSessionSourceAssertion([
        params.assertCurrent,
        targetFacts.assertCurrent,
      ]),
    });
    if (!inputs) {
      release();
      return undefined;
    }
    const { events, previous, retained } = inputs;
    params.assertCurrent();
    params.signal?.throwIfAborted();
    const parts: NonNullable<ReturnType<typeof projectConversationKnowledge>>[] = [];
    const ingestion = params.retainInHistory
      ? createConversationKnowledgeIngestion({
          maintenance: params.retainInHistory,
          activePacketIds: params.readyOnly
            ? []
            : await readActiveConversationKnowledgePacketIds({
                branch,
                assertCurrent: composeSessionSourceAssertion([
                  params.assertCurrent,
                  targetFacts.assertCurrent,
                ]),
                signal: params.signal,
              }),
          captureSources: () =>
            composeSessionSourceAssertion([
              params.assertCurrent,
              targetFacts.assertCurrent,
              ...reads.map((held) => held.grant.assertCurrent),
            ]),
        })
      : undefined;
    const { gaps, gap } = createConversationKnowledgeGapCollector();
    let packets = 0;
    let pendingPackets = false;
    let nextSourceCursor: string | undefined;
    let preparationSaturated = false;
    let sources = 0;
    let batchBlocked = false;
    let preparingRead: ConversationKnowledgeHeldSource | undefined;
    const committedReads = new Set<(typeof reads)[number]>();
    const queuedPackets: Array<{
      admission: ConversationKnowledgePacketAdmission;
      message: CustomMessage;
      read: (typeof reads)[number];
    }> = [];
    const flushPackets = async () => {
      if (!queuedPackets.length || !ingestion || !params.retainInHistory) {
        return true;
      }
      const batch = queuedPackets.splice(0);
      const result = await ingestion
        .tryBatch(
          batch.map(({ message }) => message),
          (count) =>
            retainConversationKnowledgePackets({
              branch,
              writeTarget: params.retainInHistory!.writeTarget,
              reader: params.reader,
              packets: batch.slice(0, count).map(({ admission }) => admission),
              signal: params.signal,
              contextLimits: params.retainInHistory?.contextLimits,
              expectedTranscriptVersion: params.retainInHistory?.expectedTranscriptVersion,
            }),
        )
        .catch((error: unknown) => {
          params.assertCurrent();
          targetFacts.assertCurrent();
          params.signal?.throwIfAborted();
          if (error instanceof SessionMutationFactsUnavailableError && !params.readyOnly) {
            throw error;
          }
          const refused = refusedSources();
          if (!(error instanceof SessionTranscriptReadFenceError) && refused.length === 0) {
            throw error;
          }
          for (const { admission } of batch) {
            gap(admission.receipt, "source-range-unverified");
            params.sourceCache?.invalidateContribution(
              conversationKnowledgeContributionId(admission.receipt),
            );
          }
          for (const held of new Set(batch.map(({ read }) => read))) {
            drop(held);
          }
          // A look-ahead grant can share the rewritten source without having a
          // queued packet yet. Do not carry its already-refused claim into the result.
          for (const held of refused) {
            drop(held);
          }
          return { accepted: 0, appended: 0, deferred: true, packetIds: [] };
        });
      for (const { admission, message, read } of batch.slice(0, result.accepted)) {
        committedReads.add(read);
        params.onPacket?.(message);
        params.sourceCache?.consume(
          conversationKnowledgeContributionId(admission.receipt),
          admission.offset,
        );
        logConversationKnowledgeTransfer({
          phase: "admitted",
          recipient: branch.sessionId,
          receipt: admission.receipt,
          offset: admission.offset,
          complete: admission.complete,
        });
      }
      const firstMissing = batch[result.accepted];
      if (firstMissing) {
        pendingPackets = true;
        batchBlocked = true;
        nextSourceCursor = conversationKnowledgeContributionId(firstMissing.admission.receipt);
        for (const { admission } of batch.slice(result.accepted)) {
          gap(admission.receipt, "admission-deferred");
        }
      }
      if (params.readyOnly) {
        // Keep the current source through its remaining packets; other ready
        // grants need custody only until this exact native batch has settled.
        for (const read of new Set(batch.map((packet) => packet.read))) {
          if (read !== preparingRead) {
            drop(read);
          }
        }
      }
      // An idle snapshot authorizes one native commit only. Mixed existing and
      // missing carriers may otherwise split a batch around an existing entry
      // and attempt a second write against our own now-obsolete version.
      const committedSnapshot =
        params.retainInHistory.expectedTranscriptVersion !== undefined && result.accepted > 0;
      if (committedSnapshot) {
        batchBlocked = true;
        pendingPackets ||= Boolean(params.sourceCache?.preparedPackets(1).length);
      }
      return !firstMissing && !committedSnapshot;
    };
    const receipts = selectConversationKnowledgeReceipts(
      events,
      branch.sessionId,
      branch.sessionKey,
      mode,
      branch.lifecycleRevision,
    );
    if (params.preparationOnly) {
      // Definite retirements/incarnation changes must not leave obsolete staged
      // slots ahead of every current candidate in the bounded prepared manifest.
      params.sourceCache?.retainContributions(
        new Set(receipts.map(conversationKnowledgeContributionId)),
      );
    }
    const observedPackets =
      params.readyOnly && params.sourceCache && params.retainInHistory
        ? await observePreparedConversationKnowledgePackets({
            branch,
            receipts,
            cache: params.sourceCache,
            writeTarget: params.retainInHistory.writeTarget,
            signal: params.signal,
            assertCurrent: composeSessionSourceAssertion([
              params.assertCurrent,
              targetFacts.assertCurrent,
            ]),
          })
        : undefined;
    const startIndex = params.sourceCursor
      ? Math.max(
          0,
          receipts.findIndex(
            (receipt) => conversationKnowledgeContributionId(receipt) === params.sourceCursor,
          ),
        )
      : 0;
    const sourceReader = createConversationKnowledgeSourceReader({
      branch,
      originalParticipant,
      targetFacts,
      reads,
      drop,
      rootEvidence: events.evidence,
      assertCurrent: params.assertCurrent,
      getRuntimeConfig: params.getRuntimeConfig,
      destinationAudience: params.destinationAudience,
      signal: params.signal,
      sourceCache: params.sourceCache,
      readyOnly: params.readyOnly,
      retainInHistory: Boolean(params.retainInHistory),
      preparedManifest: manifest,
      hasRetainedContribution: (id) => retained?.get(id)?.complete === true,
    });
    for (let index = startIndex; index < receipts.length; index++) {
      const receipt = receipts[index]!;
      params.signal?.throwIfAborted();
      params.assertCurrent();
      targetFacts.assertCurrent();
      const contributionId = conversationKnowledgeContributionId(receipt);
      if (observedPackets && !observedPackets.contributions.has(contributionId)) {
        continue;
      }
      const prior = previous.find((frontier) => frontier.origin === receipt.origin);
      if (
        !params.retainInHistory &&
        !params.preparationOnly &&
        isConversationKnowledgeReferenceObserved(receipt, prior)
      ) {
        continue;
      }
      const admitted = retained?.get(contributionId);
      if (admitted?.complete) {
        continue;
      }
      if (params.packetBudget !== undefined && packets >= params.packetBudget) {
        pendingPackets = true;
        nextSourceCursor = contributionId;
        break;
      }
      if (
        params.readyOnly &&
        params.sourceCache?.firstPreparedOffset(contributionId) === undefined
      ) {
        continue;
      }
      if (params.sourceBudget !== undefined && sources >= params.sourceBudget) {
        pendingPackets = true;
        nextSourceCursor = contributionId;
        break;
      }
      sources++;
      const { source: preparedSource, projection: preparedProjection } =
        await sourceReader.take(receipt);
      if (!preparedSource) {
        gap(receipt, "source-access-unavailable");
        continue;
      }
      const { read, grant, sourceAssertion, projectionTarget, through, from, facts } =
        preparedSource;
      preparingRead = read;
      const loadProjection = () =>
        sourceReader.load(
          preparedSource,
          preparedProjection,
          receipt,
          receipts[index + 1],
          params.sourceBudget === undefined || sources < params.sourceBudget,
        );
      const stagedOffset = params.readyOnly
        ? params.sourceCache?.firstPreparedOffset(contributionId)
        : undefined;
      const staged =
        params.readyOnly && stagedOffset !== undefined
          ? params.sourceCache?.peek(contributionId, stagedOffset)
          : undefined;
      const stagedValid = staged && (await sourceReader.validate(preparedSource, staged));
      params.assertCurrent();
      params.signal?.throwIfAborted();
      if (staged && !stagedValid) {
        params.sourceCache?.invalidateContribution(contributionId);
        pendingPackets = true;
      }
      const projection = await (
        params.readyOnly
          ? Promise.resolve(
              stagedValid && staged ? { events: [], version: staged.version } : undefined,
            )
          : params.sourceCache
            ? params.sourceCache.read({
                contributionId,
                target: projectionTarget,
                through,
                from,
                signal: params.signal,
                assertCurrent: sourceAssertion,
                ...(!params.readyOnly ? { load: loadProjection } : {}),
              })
            : loadProjection()
      ).catch((error: unknown) => {
        params.assertCurrent();
        targetFacts.assertCurrent();
        params.signal?.throwIfAborted();
        if (error instanceof SessionMutationFactsUnavailableError && !params.readyOnly) {
          throw error;
        }
        const refusedReads = new Set(refusedSources());
        if (
          !(error instanceof SessionTranscriptReadFenceError) &&
          !(error instanceof RangeError) &&
          refusedReads.size === 0
        ) {
          throw error;
        }
        // Rewritten or over-budget source ranges stay unresolved, never acknowledged.
        gap(
          receipt,
          error instanceof RangeError ? "source-range-over-capacity" : "source-range-unverified",
        );
        // Batched look-ahead may fail on a different source claim. Release its
        // refused custody as well, rather than escalating a soft gap at finalization.
        for (const held of refusedReads) {
          drop(held);
        }
        const refused = queuedPackets.filter(({ read: queuedRead }) =>
          refusedReads.has(queuedRead),
        );
        if (refused.length) {
          // Nothing in this queue has committed. Retry its original ordered prefix
          // rather than letting a later valid/deferred packet move past the gap.
          const uncommitted = queuedPackets.splice(0);
          pendingPackets = true;
          batchBlocked = true;
          nextSourceCursor = conversationKnowledgeContributionId(uncommitted[0]!.admission.receipt);
          for (const { admission, read: queuedRead } of uncommitted) {
            const rejected = refusedReads.has(queuedRead);
            gap(admission.receipt, rejected ? "source-range-unverified" : "admission-deferred");
            if (rejected) {
              params.sourceCache?.invalidateContribution(
                conversationKnowledgeContributionId(admission.receipt),
              );
            }
          }
        }
        return undefined;
      });
      targetFacts.assertCurrent();
      params.assertCurrent();
      if (!projection) {
        drop(read);
        if (batchBlocked) {
          break;
        }
        continue;
      }
      grant.assertCurrent();
      facts.assertCurrent();
      if (params.preparationOnly) {
        const preparation = await sourceReader.stage({
          source: preparedSource,
          receipt,
          projection,
          offset: admitted?.nextOffset ?? 0,
          expectedConsumptionRevision: preparationConsumptionRevision,
        });
        drop(read);
        if (preparation !== "complete") {
          preparationSaturated = preparation === "cache-full";
          nextSourceCursor = contributionId;
          break;
        }
        continue;
      }
      let offset = stagedOffset ?? admitted?.nextOffset ?? 0;
      let contributed = false;
      let yieldedContribution = false;
      for (;;) {
        sourceAssertion();
        const ready = params.readyOnly
          ? params.sourceCache?.peek(contributionId, offset)
          : undefined;
        if (
          ready &&
          (!isDeepStrictEqual(ready.through, through) || !isDeepStrictEqual(ready.from, from))
        ) {
          params.sourceCache?.invalidateContribution(contributionId);
          pendingPackets = true;
          break;
        }
        const part = params.readyOnly
          ? ready?.part
          : projectConversationKnowledge(
              receipt,
              projection.events,
              retained ? undefined : prior,
              facts.audience,
              { offset },
            );
        if (!part) {
          if (retained) {
            // An unavailable completed range is not a consumed range.
            gap(receipt, "source-range-unverified");
          }
          break;
        }
        if (!params.retainInHistory) {
          contributed = true;
          read.origin = receipt.origin;
          parts.push({ ...part, text: renderConversationKnowledgePacketText(receipt, part.text) });
          break;
        }
        if (!projection.version) {
          throw new Error("Conversation knowledge packet has no admitted source version");
        }
        const sourceVersion = ready?.version ?? projection.version;
        const report = createConversationKnowledgePacketReport({
          branch,
          receipt,
          text: part.text,
          offset,
          nextOffset: part.nextOffset ?? offset,
          complete: part.complete,
        });
        if (observedPackets && !observedPackets.readyPacketIds.has(report.details.packetId)) {
          pendingPackets = true;
          break;
        }
        const existingCarrier = observedPackets?.activeCarriers.get(report.details.packetId);
        const message: CustomMessage = {
          role: "custom",
          ...(existingCarrier ?? report),
          timestamp: Date.now(),
        };
        if (params.canAdmitPacket && !params.canAdmitPacket(message)) {
          gap(receipt, "admission-deferred");
          pendingPackets = true;
          break;
        }
        if (existingCarrier) {
          // The fresh native observation already proves durable, canonical model
          // membership. Do not open another append transaction for that receipt.
          // Settle an earlier queued prefix before exposing its successor.
          if (!(await flushPackets())) {
            break;
          }
          sourceAssertion();
          params.onPacket?.(message);
          params.sourceCache?.consume(contributionId, offset);
          logConversationKnowledgeTransfer({
            phase: "admitted",
            recipient: branch.sessionId,
            receipt,
            offset,
            complete: part.complete,
          });
        } else {
          queuedPackets.push({
            admission: {
              receipt,
              text: part.text,
              offset,
              nextOffset: part.nextOffset ?? offset,
              complete: part.complete,
              sourceVersion,
              source: sourceAssertion,
              historicalCustody: preparedSource.historicalCustody,
            },
            message,
            read,
          });
        }
        contributed = true;
        packets++;
        if (queuedPackets.length >= MAX_TRANSCRIPT_REPORT_BATCH_SIZE && !(await flushPackets())) {
          break;
        }
        sourceAssertion();
        if (part.frontier) {
          break;
        }
        if (part.nextOffset === undefined || part.nextOffset <= offset) {
          throw new Error("Conversation knowledge packet made no progress");
        }
        offset = part.nextOffset;
        if (params.packetBudget !== undefined && packets >= params.packetBudget) {
          pendingPackets = true;
          yieldedContribution = true;
          break;
        }
      }
      preparingRead = undefined;
      if (
        !contributed ||
        (params.retainInHistory &&
          params.readyOnly &&
          !queuedPackets.some((packet) => packet.read === read))
      ) {
        drop(read);
      }
      if (batchBlocked) {
        break;
      }
      if (yieldedContribution) {
        // The quantum ended inside this source. Its durable packet offset owns
        // the continuation; advancing to the next receipt would skip its tail.
        nextSourceCursor = contributionId;
        break;
      }
    }
    await flushPackets();
    params.assertCurrent();
    params.signal?.throwIfAborted();
    if (params.preparationOnly && params.sourceCache) {
      publishPreparedConversationKnowledgeRoot({
        branch,
        audienceIdentity: targetFacts.audienceIdentity,
        evidence: events.evidence,
        receipts,
        cache: params.sourceCache,
      });
    }
    const combined = combineConversationKnowledge(parts);
    logConversationKnowledgeDiagnostic({
      recipient: branch.sessionId,
      gaps,
      pending: ingestion?.pending ?? (combined.pending ? "snapshot-capacity" : undefined),
    });
    for (const read of reads.toReversed()) {
      if (
        params.retainInHistory
          ? !committedReads.has(read)
          : !parts.slice(0, combined.includedCount).some((part) => part.origin === read.origin)
      ) {
        drop(read);
      }
    }
    const source = composeSessionSourceAssertion(
      [
        params.assertCurrent,
        targetFacts.assertCurrent,
        ...reads.map((read) => read.grant.assertCurrent),
      ],
      (check) => {
        if (!active) {
          throw new Error("Conversation knowledge read has been released");
        }
        (params.retainedSignal ?? params.signal)?.throwIfAborted();
        check();
      },
    );
    params.signal?.throwIfAborted();
    source();
    return {
      pendingPackets,
      nextSourceCursor,
      preparationSaturated,
      fragments: params.retainInHistory
        ? []
        : combined.text
          ? [
              {
                kind: "conversation-data",
                text: `${CONVERSATION_KNOWLEDGE_NOTICE}\n${combined.text}`,
              },
            ]
          : [],
      observed: params.retainInHistory
        ? []
        : [
            ...previous.filter(
              (frontier) => !combined.frontiers.some((next) => next.origin === frontier.origin),
            ),
            ...combined.frontiers,
          ],
      assertCurrent: source,
      release,
    };
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Conversation knowledge preparation failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
