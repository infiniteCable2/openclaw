import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { CustomMessage } from "../../agents/sessions/messages.js";
import {
  prepareConversationKnowledgeBootstrap,
  prepareNewConversationKnowledgeBootstrap,
  prepareConversationKnowledgeCheckpointSelection,
  advanceConversationKnowledgeBootstrapInput,
  retainConversationKnowledgeCheckpoint,
  type PreparedConversationKnowledgeBootstrap,
  type PreparedConversationKnowledgeCheckpointSelection,
} from "../../config/sessions/conversation-knowledge-checkpoint-admission.js";
import { createConversationKnowledgeCheckpointContext } from "../../config/sessions/conversation-knowledge-checkpoint-context.js";
import { selectConversationKnowledgeCheckpointBootstrap } from "../../config/sessions/conversation-knowledge-checkpoint.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import { selectConversationKnowledgeReceipts } from "../../config/sessions/conversation-knowledge-selection.js";
import {
  issuePreparedKnowledgeRootCandidates,
  readConversationKnowledgeRoot,
  readPreparedConversationKnowledgeRoot,
  readPreparedConversationKnowledgeRootEvidence,
  type PreparedKnowledgeRootCandidates,
} from "../../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import { SessionMutationAuthorizationChangedError } from "../../gateway/session-mutation-authorization-error.js";
import {
  preparePersonalConversationContributionGroup,
  type PreparedPersonalConversationContributionGroup,
} from "../../gateway/session-transcript-personal-read.js";
import { prepareTranscriptReadAuthority } from "../../gateway/session-transcript-read-authority.js";
import type { PreparedConversationKnowledgeRootCheckpoint } from "./conversation-knowledge-checkpoint-owner.js";
import type {
  ConversationKnowledgeSourceCache,
  PreparedConversationKnowledgePacket,
} from "./conversation-knowledge-source-cache.js";
import {
  readConversationKnowledgeInputs,
  prepareConversationKnowledgeTarget,
  type ConversationKnowledgeHeldSource,
} from "./conversation-knowledge-source-reader.js";
import type {
  PreparedReplyConversationKnowledge,
  ReplyConversationKnowledgeParams,
} from "./conversation-knowledge.types.js";

export type PreparedRecipientConversationCheckpoint =
  PreparedConversationKnowledgeRootCheckpoint & {
    manifest: PreparedKnowledgeRootCandidates;
    bootstrap: PreparedConversationKnowledgeBootstrap;
    selection: PreparedConversationKnowledgeCheckpointSelection;
    groups: readonly {
      source: Readonly<Pick<ConversationKnowledgeReference["source"], "agentId" | "sessionKey">>;
      admission: PreparedPersonalConversationContributionGroup;
    }[];
  };

function checkpointReadCustody(releaseTarget: () => void, cache: ConversationKnowledgeSourceCache) {
  const reads: ConversationKnowledgeHeldSource[] = [];
  let targetReleased = false;
  let active = true;
  const drop = (read: ConversationKnowledgeHeldSource) => {
    const index = reads.indexOf(read);
    if (index < 0) {
      return;
    }
    read.grant.release();
    reads.splice(index, 1);
  };
  const release = () => {
    if (!active) {
      return;
    }
    const errors: unknown[] = [];
    for (const read of reads.toReversed()) {
      try {
        drop(read);
      } catch (error) {
        errors.push(error);
      }
    }
    if (!targetReleased) {
      try {
        releaseTarget();
        targetReleased = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      cache.retainCleanup(release);
      throw new AggregateError(errors, "Checkpoint recipient custody cleanup remains pending");
    }
    active = false;
    cache.forgetCleanup(release);
  };
  return {
    reads,
    drop,
    release,
    get active() {
      return active;
    },
  };
}

/** Reuse ready original bytes with recipient-owned native custody and durable progress. */
export async function prepareRecipientConversationProjection(
  params: ReplyConversationKnowledgeParams,
  tail: readonly {
    reference: ConversationKnowledgeReference;
    packet: PreparedConversationKnowledgePacket;
  }[],
): Promise<boolean> {
  const cache = params.sourceCache;
  if (!cache || !params.originalParticipant || !params.expectedAudienceIdentity) {
    return false;
  }
  const target = await prepareConversationKnowledgeTarget({
    ...params,
    participantIdentity: params.expectedAudienceIdentity,
  });
  if (!target || target.kind !== "ready") {
    return false;
  }
  const { branch, targetFacts } = target;
  const { reads, drop, release } = checkpointReadCustody(() => targetFacts.release(), cache);
  const check = composeSessionSourceAssertion([params.assertCurrent, targetFacts.assertCurrent]);
  const epoch = cache.consumptionRevision;
  try {
    const inputs = await readConversationKnowledgeInputs({
      ...params,
      branch,
      assertCurrent: check,
      readyOnly: false,
      preparationOnly: true,
      retainInHistory: false,
    }).catch((error: unknown) => {
      params.signal?.throwIfAborted();
      cache.clearPreparedRoot();
      throw error;
    });
    if (!inputs) {
      return false;
    }
    check();
    params.signal?.throwIfAborted();
    const { events, retained } = inputs;
    const current = selectConversationKnowledgeReceipts(
      events,
      branch.sessionId,
      branch.sessionKey,
      "branches",
      branch.lifecycleRevision,
    );
    if (cache.consumptionRevision !== epoch) {
      return false;
    }
    // Shared reuse must retire obsolete slots just like fallback preparation,
    // otherwise an old incarnation can hold the bounded cache indefinitely.
    cache.retainContributions(new Set(current.map(conversationKnowledgeContributionId)));
    const shared = new Map(
      tail.map((item) => [conversationKnowledgeContributionId(item.reference), item]),
    );
    let manifest: PreparedKnowledgeRootCandidates;
    try {
      const candidate = issuePreparedKnowledgeRootCandidates(events.evidence, current, {
        maxBytes: cache.maxPreparedRootBytes,
      });
      // Progress consumes packets, not the canonical native source selection.
      // Identical selection keeps its manifest and grouped custody across batches.
      manifest = cache.setPreparedRoot(candidate, sha256Hex(JSON.stringify(current)));
    } catch (error) {
      if (!(error instanceof RangeError)) {
        throw error;
      }
      cache.clearPreparedRoot();
      return false;
    }
    let selectedEvents: Awaited<ReturnType<typeof readPreparedConversationKnowledgeRoot>>;
    try {
      selectedEvents = await readPreparedConversationKnowledgeRoot({
        ...params,
        branch,
        manifest,
        assertCurrent: check,
      });
    } catch (error) {
      params.signal?.throwIfAborted();
      cache.clearPreparedRoot(manifest);
      throw error;
    }
    const bySource = new Map<string, ConversationKnowledgeReference[]>();
    const prepared = new Map<
      string,
      { offset: number; packet: PreparedConversationKnowledgePacket }
    >();
    let complete = true;
    for (const reference of current) {
      check();
      params.signal?.throwIfAborted();
      if (cache.consumptionRevision !== epoch) {
        return false;
      }
      const id = conversationKnowledgeContributionId(reference);
      if (retained?.get(id)?.complete || cache.preparedCheckpoint?.coverage.has(id)) {
        if (retained?.get(id)?.complete && cache.hasContribution(id)) {
          cache.invalidateContribution(id);
        }
        continue;
      }
      const item = shared.get(id),
        firstOffset = cache.firstPreparedOffset(id),
        staged = firstOffset === undefined ? undefined : cache.peek(id, firstOffset);
      const nextOffset = retained?.get(id)?.nextOffset ?? 0;
      if (!staged && (nextOffset > 0 || !item || !isDeepStrictEqual(reference, item.reference))) {
        complete = false;
        continue;
      }
      const packet = staged ?? item!.packet;
      // Native custody covers the original range, including its already staged
      // fragments. Keep their exact offsets and versions; never recreate offset
      // zero after a durable prefix or replace a segmented range with whole text.
      if (staged) {
        let offset = firstOffset!;
        let part: PreparedConversationKnowledgePacket["part"] | undefined = staged.part;
        while (part && !part.complete) {
          if (part.nextOffset === undefined || part.nextOffset <= offset) {
            break;
          }
          offset = part.nextOffset;
          part = cache.peek(id, offset)?.part;
        }
        if (firstOffset !== nextOffset || !part?.complete) {
          complete = false;
        }
      } else if (!packet.part.complete) {
        complete = false;
      }
      prepared.set(id, { offset: firstOffset ?? 0, packet });
      const key = JSON.stringify([reference.source, reference.through.storePath]);
      const references = bySource.get(key) ?? [];
      references.push(reference);
      bySource.set(key, references);
    }
    for (const references of bySource.values()) {
      const first = references[0]!;
      const sourceTarget = { ...first.source, storePath: first.through.storePath };
      let group = cache.preparedContributionGroup(sourceTarget, manifest);
      if (
        group &&
        references.every(
          (reference) =>
            prepared.has(conversationKnowledgeContributionId(reference)) &&
            cache.preparedContributionGroup(
              sourceTarget,
              manifest,
              conversationKnowledgeContributionId(reference),
            ) === group,
        )
      ) {
        continue;
      }
      const request = {
        purpose: "conversation-differences",
        personal: {
          originalParticipant: params.originalParticipant,
          assertCurrent: check,
          target: branch,
          targetAudience: params.destinationAudience,
          rootEvidence: selectedEvents.evidence,
        },
        getRuntimeConfig: params.getRuntimeConfig,
        sources: [first.source],
        signal: params.signal,
      } as const;
      let transfer = false;
      let retire: (() => void) | undefined;
      try {
        // A new recovered original can enlarge the group without changing the
        // canonical manifest. The replacement is still issued by the native owner.
        group = await preparePersonalConversationContributionGroup({
          ...request,
          personal: { ...request.personal, contributions: references },
        });
        const retainedGroup = group;
        retire = () => retainedGroup.release();
        cache.retainCleanup(retire);
        const grant = await prepareTranscriptReadAuthority({
          ...request,
          personal: { ...request.personal, contributionGroup: group },
        });
        const read = { grant };
        reads.push(read);
        check();
        params.signal?.throwIfAborted();
        if (cache.consumptionRevision !== epoch) {
          return false;
        }
        const preparedIds: string[] = [];
        for (const reference of references) {
          const id = conversationKnowledgeContributionId(reference);
          const selected = prepared.get(id);
          const packet = selected?.packet;
          const range = grant.selectContribution(reference);
          if (
            !packet ||
            !range?.version ||
            !isDeepStrictEqual(range.through, packet.through) ||
            !isDeepStrictEqual(range.from, packet.from)
          ) {
            complete = false;
            continue;
          }
          if (!cache.stage(id, selected!.offset, packet)) {
            complete = false;
            break;
          }
          preparedIds.push(id);
        }
        drop(read);
        if (!preparedIds.length) {
          complete = false;
          continue;
        }
        // The cache owns release even when bounded admission refuses the group.
        transfer = true;
        cache.forgetCleanup(retire);
        if (!cache.retainContributionGroup(preparedIds, sourceTarget, group, manifest)) {
          complete = false;
        }
      } catch (error) {
        check();
        params.signal?.throwIfAborted();
        if (
          !(error instanceof SessionTranscriptReadFenceError) &&
          !(error instanceof SessionMutationAuthorizationChangedError)
        ) {
          throw error;
        }
        cache.invalidateAdmission(sourceTarget);
        complete = false;
      } finally {
        if (!transfer && retire) {
          retire();
          cache.forgetCleanup(retire);
        }
      }
    }
    check();
    params.signal?.throwIfAborted();
    if (cache.consumptionRevision !== epoch) {
      return false;
    }
    return complete;
  } finally {
    release();
  }
}

/** Prepare a bootstrap without hydrating source text. Every summary donor still needs native custody. */
export async function prepareRecipientConversationCheckpoint(
  params: ReplyConversationKnowledgeParams,
  latest: PreparedConversationKnowledgeRootCheckpoint,
  initialBootstrap?: PreparedConversationKnowledgeBootstrap,
): Promise<void> {
  const cache = params.sourceCache;
  if (!cache || !params.originalParticipant || !params.expectedAudienceIdentity) {
    return;
  }
  const target = await prepareConversationKnowledgeTarget({
    ...params,
    participantIdentity: params.expectedAudienceIdentity,
  });
  if (!target || target.kind !== "ready") {
    return;
  }
  const { branch, targetFacts } = target;
  const { reads, drop, release } = checkpointReadCustody(() => targetFacts.release(), cache);
  const check = composeSessionSourceAssertion([params.assertCurrent, targetFacts.assertCurrent]);
  try {
    const bootstrap =
      initialBootstrap ??
      (await prepareConversationKnowledgeBootstrap({
        branch,
        env: params.reader.database.env,
        source: check,
        signal: params.signal,
      }));
    if (!bootstrap) {
      return;
    }
    const events = await readConversationKnowledgeRoot({ ...params, branch, assertCurrent: check });
    const references = selectConversationKnowledgeReceipts(
      events,
      branch.sessionId,
      branch.sessionKey,
      "branches",
      branch.lifecycleRevision,
    ).filter((reference) => latest.coverage.has(conversationKnowledgeContributionId(reference)));
    if (
      !selectConversationKnowledgeCheckpointBootstrap({
        ...latest,
        branch,
        audienceKey: params.expectedAudienceIdentity,
        progress: new Map(),
        availableReferences: references,
      })
    ) {
      return;
    }
    const manifest = issuePreparedKnowledgeRootCandidates(events.evidence, references, {
      maxBytes: cache.maxPreparedRootBytes,
      sharedMetadata: true,
    });
    // Prepare against the exact selected manifest scope that the model boundary
    // will rebind, not the larger root read's independently issued membership.
    const selectedEvents = await readPreparedConversationKnowledgeRoot({
      ...params,
      branch,
      manifest,
      assertCurrent: check,
    });
    if (!selectedEvents.evidence) {
      return;
    }
    const bySource = new Map<string, ConversationKnowledgeReference[]>();
    for (const reference of references) {
      const key = JSON.stringify([reference.source, reference.through.storePath]);
      const group = bySource.get(key) ?? [];
      group.push(reference);
      bySource.set(key, group);
    }
    const groups: PreparedRecipientConversationCheckpoint["groups"][number][] = [];
    const retirements: (() => void)[] = [];
    try {
      for (const selected of bySource.values()) {
        const request = {
          purpose: "conversation-differences",
          personal: {
            originalParticipant: params.originalParticipant,
            assertCurrent: check,
            target: branch,
            targetAudience: params.destinationAudience,
            rootEvidence: selectedEvents.evidence,
          },
          getRuntimeConfig: params.getRuntimeConfig,
          sources: [selected[0]!.source],
        } as const;
        const admission = await preparePersonalConversationContributionGroup({
          ...request,
          personal: { ...request.personal, contributions: selected },
        });
        const retire = () => admission.release();
        retirements.push(retire);
        cache.retainCleanup(retire);
        const grant = await prepareTranscriptReadAuthority({
          ...request,
          personal: { ...request.personal, contributionGroup: admission },
        });
        const read = { grant };
        reads.push(read);
        for (const reference of selected) {
          const range = grant.selectContribution(reference);
          if (!range || !latest.coverage.matchesReference(reference, range)) {
            return;
          }
        }
        drop(read);
        groups.push(
          Object.freeze({
            source: Object.freeze({
              agentId: selected[0]!.source.agentId,
              sessionKey: selected[0]!.source.sessionKey,
            }),
            admission,
          }),
        );
      }
      check();
      params.signal?.throwIfAborted();
      const selection = prepareConversationKnowledgeCheckpointSelection({
        ...latest,
        branch,
        audienceKey: params.expectedAudienceIdentity,
        manifest,
        rootEvidence: selectedEvents.evidence,
        availableReferences: references,
        source: check,
      });
      if (!selection) {
        return;
      }
      if (
        cache.stageCheckpoint(
          Object.freeze({
            ...latest,
            checkpoint: selection.checkpoint,
            manifest,
            bootstrap,
            selection,
            groups: Object.freeze(groups),
          }),
        )
      ) {
        for (const retire of retirements) {
          cache.forgetCleanup(retire);
        }
      }
    } finally {
      cache.retryCleanup();
    }
  } finally {
    release();
  }
}

/** Model boundary: prepared proof + fresh grants + native budget/atomic append, never source hydration. */
export async function admitRecipientConversationCheckpoint(
  params: ReplyConversationKnowledgeParams,
): Promise<PreparedReplyConversationKnowledge | undefined> {
  const cache = params.sourceCache;
  const candidate = cache?.preparedCheckpoint;
  if (
    !cache ||
    !candidate ||
    !params.originalParticipant ||
    !params.retainInHistory ||
    !params.canAdmitPacket
  ) {
    return undefined;
  }
  const target = await prepareConversationKnowledgeTarget({
    ...params,
    participantIdentity: candidate.checkpoint.audienceKey,
  });
  if (!target || target.kind !== "ready") {
    return undefined;
  }
  const { branch, targetFacts } = target;
  const custody = checkpointReadCustody(() => targetFacts.release(), cache);
  const { reads, release } = custody;
  const check = composeSessionSourceAssertion([params.assertCurrent, targetFacts.assertCurrent]);
  let retained = false;
  try {
    const rootEvidence = await readPreparedConversationKnowledgeRootEvidence({
      ...params,
      branch,
      manifest: candidate.manifest,
      assertCurrent: check,
    });
    candidate.selection.validate({
      ...candidate,
      branch,
      audienceKey: candidate.checkpoint.audienceKey,
      rootEvidence,
    });
    for (const group of candidate.groups) {
      const grant = await prepareTranscriptReadAuthority({
        purpose: "conversation-differences",
        personal: {
          originalParticipant: params.originalParticipant,
          assertCurrent: check,
          target: branch,
          targetAudience: params.destinationAudience,
          rootEvidence,
          contributionGroup: group.admission,
        },
        getRuntimeConfig: params.getRuntimeConfig,
        sources: [group.source],
      });
      reads.push({ grant });
    }
    const authority = composeSessionSourceAssertion(
      [check, ...reads.map((read) => read.grant.assertCurrent)],
      (assert) => {
        if (!custody.active) {
          throw new Error("Checkpoint recipient grant was released");
        }
        (params.retainedSignal ?? params.signal)?.throwIfAborted();
        assert();
      },
    );
    const report = createConversationKnowledgeCheckpointContext({
      checkpoint: candidate.checkpoint,
      branch,
    });
    const message: CustomMessage = { role: "custom", ...report, timestamp: Date.now() };
    let bootstrap = params.bootstrapInput
      ? await advanceConversationKnowledgeBootstrapInput({
          branch,
          bootstrap: candidate.bootstrap,
          admission: params.bootstrapInput,
          source: authority,
          signal: params.signal,
          env: params.reader.database.env,
        })
      : candidate.bootstrap;
    if (!bootstrap && params.bootstrapInput && params.bootstrapInitialization) {
      // The SDK's exact initial model/thinking entries are metadata, not imported
      // conversation. Prove the entire tiny initial transcript instead of allowing
      // arbitrary controls to advance an existing recipient's proof.
      bootstrap = await prepareNewConversationKnowledgeBootstrap({
        branch,
        admission: params.bootstrapInput,
        initialization: params.bootstrapInitialization,
        source: authority,
        signal: params.signal,
        env: params.reader.database.env,
      });
    }
    if (!bootstrap) {
      cache.clearCheckpoint(candidate);
      return undefined;
    }
    if (!params.canAdmitPacket(message)) {
      return undefined;
    }
    const result = await retainConversationKnowledgeCheckpoint({
      ...candidate,
      bootstrap,
      branch,
      audienceKey: candidate.checkpoint.audienceKey,
      rootEvidence,
      writeTarget: params.retainInHistory.writeTarget,
      reader: params.reader,
      source: authority,
      signal: params.signal,
      contextLimits: params.retainInHistory.contextLimits,
    });
    if (!result.accepted) {
      return undefined;
    }
    cache.consumeCheckpoint(candidate);
    params.onPacket?.(message);
    retained = true;
    return { fragments: [], observed: [], assertCurrent: authority, release, pendingPackets: true };
  } catch (error) {
    cache.clearCheckpoint(candidate);
    params.assertCurrent();
    params.signal?.throwIfAborted();
    if (
      error instanceof SessionTranscriptReadFenceError ||
      error instanceof SessionMutationAuthorizationChangedError
    ) {
      return undefined;
    }
    throw error;
  } finally {
    if (!retained) {
      release();
    }
  }
}
