import path from "node:path";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { requiredWorkerHelperError } from "../../config/required-worker-profile.js";
import { cloneConfigWithResolutionFacts } from "../../config/resolution-facts.js";
import {
  configSnapshotsMatch,
  createRuntimeConfigSnapshotMatcher,
} from "../../config/runtime-config-snapshot-match.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import {
  appendConversationKnowledgeCheckpoint,
  readConversationKnowledgeCheckpointCoverage,
  readLatestConversationKnowledgeCheckpoint,
} from "../../config/sessions/conversation-knowledge-checkpoint-store.js";
import {
  createConversationKnowledgeCheckpoint,
  conversationKnowledgeCheckpointRangeDigest,
  type ConversationKnowledgeCheckpoint,
  type PreparedConversationKnowledgeCheckpointCoverage,
} from "../../config/sessions/conversation-knowledge-checkpoint.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import { ConversationKnowledgeRootContinuation } from "../../config/sessions/conversation-knowledge-root-cache.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createBackgroundWorkOwner } from "../../process/background-work.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { createConversationKnowledgeCheckpointFrameSlot } from "./conversation-knowledge-checkpoint-frame.js";
import type { ConversationKnowledgeCheckpointModel } from "./conversation-knowledge-checkpoint-model.js";
import type {
  prepareConversationKnowledgeCheckpointSources,
  PreparedRootKnowledgeContribution,
} from "./conversation-knowledge-checkpoint-source.js";
import type { PreparedCheckpointContribution } from "./conversation-knowledge-checkpoint-summary.js";
import { createConversationKnowledgePrefetchOwner } from "./conversation-knowledge-prefetch-owner.js";

type Registration = {
  branch: ConversationKnowledgeBranch;
  participant: SessionParticipantIdentity;
  audience: ConversationPrivateAudience;
  env: NodeJS.ProcessEnv;
  getRuntimeConfig(): OpenClawConfig;
  /** Requests ordinary background recipient preparation; never starts a model turn. */
  onReady?(): void;
};
export type PreparedConversationKnowledgeRootCheckpoint = {
  checkpoint: ConversationKnowledgeCheckpoint;
  coverage: PreparedConversationKnowledgeCheckpointCoverage;
};
type RootOwner = ReturnType<typeof createRootOwner>;
const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.conversationKnowledgeCheckpointOwners"),
  () => new Map<string, RootOwner>(),
);
const workOwner = createBackgroundWorkOwner({
  owner: "conversation-knowledge-checkpoints",
  maxConcurrent: 1,
});
const log = createSubsystemLogger("conversation-knowledge");

function createRootOwner(initial: Registration, audienceKey: string, dispose: () => void) {
  const rootContinuation = new ConversationKnowledgeRootContinuation();
  const authorityLifetime = new AbortController();
  const frames = createConversationKnowledgeCheckpointFrameSlot();
  const brokers = new Set<Registration>();
  let latest: PreparedConversationKnowledgeRootCheckpoint | undefined;
  let inFlight: AbortController | undefined;
  let reportedWorkerPolicy = false;
  const pendingCleanup = new Set<() => Promise<void>>();
  const settle = async () => {
    const failures: unknown[] = [];
    try {
      await frames.settle(authorityLifetime.signal.aborted);
    } catch (error) {
      failures.push(error);
    }
    // Cleanup may mutate the set while awaiting; retry only this pass's captured owners.
    const cleanupSnapshot = Array.from(pendingCleanup);
    for (const cleanup of cleanupSnapshot) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Checkpoint cleanup remains pending");
    }
  };
  let planning:
    | { config: OpenClawConfig; value: ConversationKnowledgeCheckpointModel["planning"] }
    | undefined;
  // Disposable complete originals only; current permission is acquired again before synthesis.
  const tail = new Map<
    string,
    {
      referenceKey: string;
      value: PreparedRootKnowledgeContribution;
      bytes: number;
      order: number;
    }
  >();
  let tailBytes = 0;
  let projectionRevision = 0;
  let loggedProjectionRevision = -1;
  let sourceSessionKeys = new Set<string>();
  const evict = (id: string) => {
    const entry = tail.get(id);
    if (entry) {
      tailBytes -= entry.bytes;
      tail.delete(id);
      projectionRevision++;
    }
  };
  const notify = () => {
    if (loggedProjectionRevision !== projectionRevision) {
      const frontiers = new Map<string, number>();
      for (const { value } of tail.values()) {
        const { sessionId, rawSeq } = value.packet.through;
        const sourceHash = redactIdentifier(sessionId);
        frontiers.set(sourceHash, Math.max(frontiers.get(sourceHash) ?? -1, rawSeq));
      }
      log.debug("Related-history root projection ready", {
        rootHash: redactIdentifier(JSON.stringify([initial.branch.agentId, initial.branch.root])),
        revision: projectionRevision,
        preparedTailCount: tail.size,
        checkpointId: latest?.checkpoint.checkpointId ?? null,
        preparedSourceFrontiers: [...frontiers]
          .slice(0, 8)
          .map(([sourceHash, throughSeq]) => ({ sourceHash, throughSeq })),
      });
      loggedProjectionRevision = projectionRevision;
    }
    for (const broker of brokers) {
      try {
        broker.onReady?.();
      } catch {
        log.debug("Related-history checkpoint notification deferred");
      }
    }
  };
  const publish = (value: PreparedConversationKnowledgeRootCheckpoint) => {
    const changed = latest?.checkpoint.checkpointId !== value.checkpoint.checkpointId;
    latest = value;
    if (changed) {
      projectionRevision++;
      notify();
    }
  };
  const selectBroker = () => {
    for (const broker of brokers) {
      try {
        broker.audience.assertCurrent();
        if (
          resolveAgentConversationMode(broker.getRuntimeConfig(), broker.branch.agentId) !==
          "branches"
        ) {
          continue;
        }
        return { broker, audience: broker.audience };
      } catch {
        brokers.delete(broker);
      }
    }
    throw new Error("Checkpoint root has no current private broker");
  };
  const assertCurrent = () => {
    selectBroker();
  };
  // The caller installs its first proof before native scheduling begins.
  const first = { ...initial };
  brokers.add(first);
  const owner = createConversationKnowledgePrefetchOwner({
    target: { ...initial.branch, env: initial.env },
    workOwner,
    settle,
    assertCurrent,
    watchesSource: (sessionKey) => sourceSessionKeys.has(sessionKey),
    clear: () => {
      inFlight?.abort();
      authorityLifetime.abort();
      frames.clear();
      brokers.clear();
      latest = undefined;
      planning = undefined;
      tail.clear();
      tailBytes = 0;
      sourceSessionKeys.clear();
      rootContinuation.release();
      // Native resource custody joins cleanup; this retired selector must not
      // prevent a fresh same-root registration while that cleanup settles.
      dispose();
    },
    async prepare(parentSignal) {
      await settle();
      const selected = selectBroker();
      const { broker, audience } = selected;
      const controller = new AbortController();
      inFlight = controller;
      const signal = AbortSignal.any([parentSignal, controller.signal]);
      const config = cloneConfigWithResolutionFacts(broker.getRuntimeConfig());
      const matchesConfig = createRuntimeConfigSnapshotMatcher(config);
      const assertAuthority = () => {
        authorityLifetime.signal.throwIfAborted();
        owner.assertCurrent();
        if (!brokers.has(broker)) {
          throw new Error("Checkpoint broker registration ended");
        }
        audience.assertCurrent();
        if (!matchesConfig(broker.getRuntimeConfig())) {
          throw new Error("Checkpoint configuration changed");
        }
      };
      const check = () => {
        signal.throwIfAborted();
        assertAuthority();
      };
      let held: Awaited<ReturnType<typeof loadSessionEntryForAdmission>> | undefined;
      let sources:
        | Awaited<ReturnType<typeof prepareConversationKnowledgeCheckpointSources>>
        | undefined;
      let model: ConversationKnowledgeCheckpointModel | undefined;
      let releaseModel: (() => Promise<void>) | undefined;
      let releaseSources: (() => void) | undefined;
      let retained = false;
      const releaseCustody = async () => {
        releaseSources?.();
        releaseSources = undefined;
        await held?.databaseClaim.release();
        held = undefined;
      };
      const cleanup = async () => {
        const failures: unknown[] = [];
        try {
          await (releaseModel ? releaseModel() : model?.[Symbol.asyncDispose]());
          model = undefined;
          releaseModel = undefined;
        } catch (error) {
          failures.push(error);
        }
        if (!retained && !model && !releaseModel) {
          try {
            await releaseCustody();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) {
          throw new AggregateError(failures, "Checkpoint preparation cleanup remains pending");
        }
        pendingCleanup.delete(cleanup);
      };
      pendingCleanup.add(cleanup);
      try {
        held = await loadSessionEntryForAdmission(
          { ...broker.branch, env: broker.env },
          { signal: authorityLifetime.signal, assertCurrent: assertAuthority },
        );
        check();
        if (
          held.entry?.sessionId !== broker.branch.sessionId ||
          held.entry.lifecycleRevision !== broker.branch.lifecycleRevision
        ) {
          // A reset retires this broker incarnation, not another still-current connection.
          brokers.delete(broker);
          return brokers.size > 0;
        }
        if (
          !("kind" in held.databaseClaim) ||
          held.databaseClaim.kind !== "worker" ||
          !held.databaseClaim.reader
        ) {
          return false;
        }
        const scopeSource = () => {
          assertAuthority();
          if (!held) {
            throw new Error("Checkpoint database custody ended");
          }
          held.databaseClaim.assertCurrent();
        };
        const { prepareConversationKnowledgeCheckpointSources } =
          await import("./conversation-knowledge-checkpoint-source.js");
        sources = await prepareConversationKnowledgeCheckpointSources({
          ...broker,
          audience,
          reader: held.databaseClaim.reader,
          rootContinuation,
          signal,
          assertCurrent: scopeSource,
          authority: { signal: authorityLifetime.signal, assertCurrent: scopeSource },
          retainCleanup(release) {
            releaseSources = release;
          },
        });
        const preparedSources = sources;
        const retainFrame = async (selectedTail: readonly PreparedRootKnowledgeContribution[]) => {
          const frame = await preparedSources.prepareInitialContextFrame({
            ...(latest ? { checkpoint: latest.checkpoint, coverage: latest.coverage } : {}),
            tail: selectedTail,
          });
          if (frame) {
            try {
              check();
              frames.publish(frame, releaseCustody);
              retained = true;
            } finally {
              if (!retained) {
                await frame.release();
              }
            }
          }
        };
        // Receipt reads require the existing prepared native row predicates,
        // not only this owner's process/configuration lifetime check.
        const checkpointSource = sources.source();
        const previous = await readLatestConversationKnowledgeCheckpoint({
          branch: broker.branch,
          audienceKey,
          source: checkpointSource,
          signal,
        });
        const previousCoverage = previous
          ? latest?.checkpoint.checkpointId === previous.checkpointId
            ? latest.coverage
            : await readConversationKnowledgeCheckpointCoverage({
                reader: held.databaseClaim.reader,
                branch: broker.branch,
                checkpoint: previous,
                source: checkpointSource,
                signal,
              })
          : undefined;
        if (!previous) {
          latest = undefined;
        }
        const { planConversationKnowledgeCheckpointSummary } =
          await import("./conversation-knowledge-checkpoint-summary.js");
        check();
        const byId = new Map(
          sources.references.map((reference) => [
            conversationKnowledgeContributionId(reference),
            reference,
          ]),
        );
        sourceSessionKeys = new Set(
          sources.references.map((reference) => reference.source.sessionKey),
        );
        const referenceOrder = new Map(
          sources.references.map((reference, index) => [
            conversationKnowledgeContributionId(reference),
            index,
          ]),
        );
        // A checkpoint is not authority for retired or unproven historical incarnations.
        const previousContinuityAvailable = !(
          previousCoverage &&
          [...previousCoverage.contributionIds()].some(
            (id) => !byId.has(id) || !previousCoverage.matchesReference(byId.get(id)!),
          )
        );
        if (!previousContinuityAvailable) {
          if (latest) {
            projectionRevision++;
          }
          latest = undefined;
          log.debug("Related-history checkpoint deferred", {
            reason: "source-continuity-unavailable",
          });
        }
        if (previous && previousCoverage && previousContinuityAvailable) {
          publish({ checkpoint: previous, coverage: previousCoverage });
        }
        // A missing prior source prevents summary-chain reuse, not preparation
        // of independently authorized current originals. Never rewrite coverage.
        const reusableCoverage = previousContinuityAvailable ? previousCoverage : undefined;
        const remaining = sources.references.filter(
          (reference) => !reusableCoverage?.has(conversationKnowledgeContributionId(reference)),
        );
        for (const [id, cached] of tail) {
          const reference = byId.get(id);
          if (
            !reference ||
            reusableCoverage?.has(id) ||
            JSON.stringify(reference) !== cached.referenceKey
          ) {
            evict(id);
          } else if (cached.order !== referenceOrder.get(id)) {
            cached.order = referenceOrder.get(id)!;
            projectionRevision++;
          }
        }
        if (!remaining.length) {
          await retainFrame([]);
          return false;
        }
        const acquireModel = async () => {
          if (!model) {
            const { acquireConversationKnowledgeCheckpointModel } =
              await import("./conversation-knowledge-checkpoint-model.js");
            check();
            model = await acquireConversationKnowledgeCheckpointModel({
              config,
              agentId: broker.branch.agentId,
              signal,
              assertCurrent: check,
              retainCleanup(release) {
                releaseModel = release;
              },
            });
          }
          planning = { config, value: model.planning };
          return model;
        };
        const maxTailBytes = Math.min(
          4 * 1024 * 1024,
          planning && configSnapshotsMatch(planning.config, config)
            ? planning.value.budget.contextTokenBudget * 32
            : Number.POSITIVE_INFINITY,
        );
        const contributions: PreparedCheckpointContribution[] = [];
        const selectedContributions = new Map<string, PreparedRootKnowledgeContribution>();
        let unavailableContributions = 0;
        for (const reference of remaining) {
          const id = conversationKnowledgeContributionId(reference);
          let cached = tail.get(id);
          if (!cached) {
            const value = await sources.read(reference, false);
            if (!value) {
              // An unverified original cannot enter coverage, but must not
              // prevent later valid originals from reaching the shared tail.
              unavailableContributions++;
              continue;
            }
            const bytes =
              Buffer.byteLength(value.text, "utf8") +
              Buffer.byteLength(JSON.stringify(value.packet), "utf8") +
              Buffer.byteLength(JSON.stringify(reference), "utf8");
            cached = {
              referenceKey: JSON.stringify(reference),
              value,
              bytes,
              order: referenceOrder.get(id)!,
            };
            // This bounds reusable memory only; uncached whole originals still participate
            // in native token-pressure planning and never trigger byte-based compaction.
            if (tailBytes + bytes <= maxTailBytes) {
              tail.set(id, cached);
              tailBytes += bytes;
              projectionRevision++;
            }
          }
          contributions.push(cached.value);
          selectedContributions.set(id, cached.value);
          check();
        }
        if (unavailableContributions > 0) {
          log.debug("Related-history checkpoint leaves source ranges pending", {
            rootHash: redactIdentifier(JSON.stringify([broker.branch.agentId, broker.branch.root])),
            reason: "source-range-unavailable",
            unavailableContributions,
          });
        }
        await retainFrame([...selectedContributions.values()]);
        if (projectionRevision !== loggedProjectionRevision) {
          notify();
        }
        if (requiredWorkerHelperError(broker.getRuntimeConfig())) {
          if (!reportedWorkerPolicy) {
            log.warn(
              "Related-history checkpoint summarization is unavailable under required worker placement.",
              { reason: "sessionless-worker-placement-unsupported" },
            );
          }
          reportedWorkerPolicy = true;
          return false;
        }
        reportedWorkerPolicy = false;
        if (!planning || !configSnapshotsMatch(planning.config, config)) {
          await acquireModel();
        }
        if (!previousContinuityAvailable || !planning!.value.settings.enabled) {
          return false;
        }
        // Hydrate the complete available tail once, then run the native planner
        // once. Provider acquisition or summarization must not hold back later originals.
        const plan = planConversationKnowledgeCheckpointSummary({
          ...planning!.value,
          contributions,
          previousSummary: previous?.summary,
        });
        if (plan.kind !== "ready") {
          return false;
        }
        for (const contribution of contributions) {
          const current = selectedContributions.get(contribution.contributionId)!;
          if (
            conversationKnowledgeCheckpointRangeDigest(current.reference, current.packet) !==
            conversationKnowledgeCheckpointRangeDigest(current.reference, {
              through: current.reference.readRange?.through ?? current.reference.through,
              from:
                current.reference.readRange?.admission ??
                current.reference.privateAudience?.admission,
            })
          ) {
            evict(contribution.contributionId);
            throw new Error("Checkpoint prepared source bytes changed");
          }
          if (!(await sources.validate(current.reference, current.packet))) {
            evict(contribution.contributionId);
            return false;
          }
        }
        // Prior summary disclosure needs every original source's current grant as well.
        // Those exact IDs stay outside model input and never become a second summary ledger.
        if (previousCoverage) {
          const verified = await sources.verifyAll(
            [...previousCoverage.contributionIds()].map((id) => byId.get(id)!),
            (reference, range) => {
              if (!previousCoverage.matchesReference(reference, range)) {
                throw new Error("Checkpoint previous source range changed");
              }
            },
          );
          if (!verified) {
            return false;
          }
        }
        const sourceAuthority = sources.source();
        sourceAuthority();
        const candidate = await (
          await acquireModel()
        ).summarize({
          contributions,
          previousSummary: previous?.summary,
          signal,
          assertCurrent: sourceAuthority,
        });
        check();
        if (candidate.kind !== "candidate") {
          return false;
        }
        const checkpoint = createConversationKnowledgeCheckpoint({
          branch: broker.branch,
          audienceKey,
          summary: candidate.summary,
          previous,
          previousCoverage,
          covered: candidate.coveredContributionIds.map((id) => byId.get(id)!),
        });
        await appendConversationKnowledgeCheckpoint({
          branch: broker.branch,
          checkpoint,
          previousCoverage,
          source: sourceAuthority,
          signal,
        });
        check();
        const coverage = await readConversationKnowledgeCheckpointCoverage({
          reader: held.databaseClaim.reader,
          branch: broker.branch,
          checkpoint,
          source: checkpointSource,
          signal,
        });
        check();
        publish({ checkpoint, coverage });
        for (const id of candidate.coveredContributionIds) {
          evict(id);
        }
        log.debug("Related-history checkpoint prepared", {
          summarizedContributions: candidate.coveredContributionIds.length,
          retainedContributions: candidate.retainedContributionIds.length,
        });
        return true;
      } catch (error) {
        // Foreground work cancels preparation without becoming a retry/error notification.
        if (controller.signal.aborted && !parentSignal.aborted) {
          return false;
        }
        throw error;
      } finally {
        try {
          await cleanup();
        } finally {
          if (inFlight === controller) {
            inFlight = undefined;
          }
          if (projectionRevision !== loggedProjectionRevision) {
            notify();
          }
        }
      }
    },
  });
  const registration = (broker: Registration) => {
    let active = true;
    return {
      request: owner.request,
      watchesSource: (sessionKey: string) => sourceSessionKeys.has(sessionKey),
      pausePreparation() {
        const resume = owner.pausePreparation();
        inFlight?.abort();
        return resume;
      },
      latest() {
        owner.assertCurrent();
        return (
          latest && { checkpoint: structuredClone(latest.checkpoint), coverage: latest.coverage }
        );
      },
      projection() {
        owner.assertCurrent();
        return {
          audienceKey,
          ...(latest
            ? { checkpoint: structuredClone(latest.checkpoint), coverage: latest.coverage }
            : {}),
          tail: [...tail.values()]
            .toSorted((left, right) => left.order - right.order)
            .map(({ value }) => ({
              reference: structuredClone(value.reference),
              packet: structuredClone(value.packet),
            })),
        };
      },
      acquireInitialFrame() {
        owner.assertCurrent();
        return frames.acquire();
      },
      async close() {
        if (!active) {
          if (!brokers.size) {
            await owner.close();
          }
          return;
        }
        active = false;
        brokers.delete(broker);
        if (!brokers.size) {
          await owner.close();
        } else {
          owner.request();
        }
      },
    };
  };
  return {
    first: registration(first),
    add(params: Registration) {
      const broker = { ...params };
      brokers.add(broker);
      try {
        owner.assertCurrent();
      } catch (error) {
        brokers.delete(broker);
        throw error;
      }
      owner.request();
      return registration(broker);
    },
  };
}

function selectPreparedRootOwner(params: {
  branch: ConversationKnowledgeBranch;
  participant: SessionParticipantIdentity;
}) {
  const identity = conversationKnowledgeParticipantIdentity(params.participant);
  if (!identity) {
    return undefined;
  }
  const key = JSON.stringify([
    params.branch.agentId,
    path.resolve(params.branch.storePath),
    params.branch.root,
    identity,
  ]);
  return owners.get(key)?.first;
}

/** Detached content is a cold fallback; the caller acquires its own disclosure authority. */
export function readPreparedConversationKnowledgeRootProjection(
  params: Parameters<typeof selectPreparedRootOwner>[0],
) {
  return selectPreparedRootOwner(params)?.projection();
}

/** Borrow already prepared custody; native creation still proves its own private destination. */
export function acquirePreparedConversationKnowledgeInitialFrame(
  params: Parameters<typeof selectPreparedRootOwner>[0],
) {
  return selectPreparedRootOwner(params)?.acquireInitialFrame();
}

/** Shared root preparation is independent of any one call and never changes recipient history. */
export function registerConversationKnowledgeCheckpointOwner(params: Registration) {
  params.audience.assertCurrent();
  const identity = conversationKnowledgeParticipantIdentity(params.participant);
  if (
    !identity ||
    identity !== conversationKnowledgeParticipantIdentity(params.audience.participant) ||
    params.audience.agentId !== params.branch.agentId ||
    params.audience.sessionKey !== params.branch.sessionKey ||
    resolveAgentConversationMode(params.getRuntimeConfig(), params.branch.agentId) !== "branches"
  ) {
    throw new Error("Checkpoint registration requires a current private branch");
  }
  const key = JSON.stringify([
    params.branch.agentId,
    path.resolve(params.branch.storePath),
    params.branch.root,
    identity,
  ]);
  const existing = owners.get(key);
  if (existing) {
    return existing.add(params);
  }
  const root = createRootOwner(params, identity, () => {
    // Construction failure precedes installation; no root is selectable then.
    if (owners.has(key) && owners.get(key) === root) {
      owners.delete(key);
    }
  });
  owners.set(key, root);
  return root.first;
}
