import { isDeepStrictEqual } from "node:util";
import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { createRuntimeConfigSnapshotMatcher } from "../../config/runtime-config-snapshot-match.js";
import { isConversationBranchCreationAudienceConfirmed } from "../../config/sessions/conversation-branch-creation-audience.js";
import { prepareConversationBranchCreation } from "../../config/sessions/conversation-branch-creation.js";
import {
  readLatestConversationKnowledgeCheckpoint,
  readConversationKnowledgeCheckpointCoverage,
} from "../../config/sessions/conversation-knowledge-checkpoint-store.js";
import { selectConversationKnowledgeCheckpointBootstrap } from "../../config/sessions/conversation-knowledge-checkpoint.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type { PreparedReplySessionInitialContext } from "../../config/sessions/session-accessor.reset.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import {
  createProjectedInitialSessionContextEvents,
  type PreparedProjectedInitialSessionContext,
  type PreparedInitialSessionContextSourceClaim,
} from "../../config/sessions/session-initial-context.js";
import {
  composeSessionSourceAssertion,
  prepareSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourcePredicate,
} from "../../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isIncognitoSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { readPreparedConversationKnowledgeRootProjection } from "./conversation-knowledge-checkpoint-owner.js";
import { prepareConversationKnowledgeCheckpointSources } from "./conversation-knowledge-checkpoint-source.js";

/** The absent recipient has no read grant; its native creation capability owns this disclosure. */
export async function prepareConversationKnowledgeInitialContext(params: {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionEntry: InternalSessionEntry;
  cfg: OpenClawConfig;
  getRuntimeConfig(): OpenClawConfig;
  audience?: ConversationPrivateAudience;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
}): Promise<PreparedReplySessionInitialContext | undefined> {
  const topology = params.sessionEntry.conversationTopology;
  if (
    resolveAgentConversationMode(params.cfg, params.agentId) !== "branches" ||
    topology?.role !== "branch" ||
    !params.sessionEntry.lifecycleRevision ||
    params.sessionEntry.incognito ||
    isIncognitoSessionKey(params.sessionKey) ||
    isSubagentSessionKey(params.sessionKey) ||
    params.sessionEntry.parentSessionKey !== undefined ||
    params.sessionEntry.parentSessionId !== undefined ||
    params.sessionEntry.parentSessionLifecycleRevision !== undefined ||
    params.sessionEntry.spawnedBy !== undefined ||
    params.sessionEntry.spawnedBySessionId !== undefined ||
    params.sessionEntry.spawnDepth !== undefined ||
    params.sessionEntry.forkSource !== undefined ||
    params.sessionEntry.forkedFromParent === true ||
    !params.audience ||
    !isConversationBranchCreationAudienceConfirmed({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      entry: params.sessionEntry,
      audience: params.audience,
    })
  ) {
    return undefined;
  }
  const audience = params.audience;
  const matchesConfig = createRuntimeConfigSnapshotMatcher(params.cfg);
  const requestedBranch: ConversationKnowledgeBranch = {
    agentId: params.agentId,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    sessionId: params.sessionEntry.sessionId,
    lifecycleRevision: params.sessionEntry.lifecycleRevision,
    root: {
      sessionKey: topology.rootSessionKey,
      sessionId: topology.rootSessionId,
      lifecycleRevision: topology.rootSessionLifecycleRevision,
    },
  };
  let active = true;
  const check = () => {
    if (!active) {
      throw new Error("Initial conversation projection has been released");
    }
    params.signal?.throwIfAborted();
    params.assertCurrent();
    audience.assertCurrent();
    if (!matchesConfig(params.getRuntimeConfig())) {
      throw new Error("Initial conversation projection configuration changed");
    }
  };
  check();
  const { databaseClaim } = await loadSessionEntryForAdmission(
    {
      agentId: requestedBranch.agentId,
      sessionKey: requestedBranch.root.sessionKey,
      storePath: requestedBranch.storePath,
    },
    { signal: params.signal, assertCurrent: check },
  );
  const cleanups: Array<() => void | Promise<void>> = [() => databaseClaim.release()];
  const release = async () => {
    active = false;
    const failures: unknown[] = [];
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup();
        cleanups.splice(cleanups.indexOf(cleanup), 1);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Initial projection cleanup remains pending");
    }
  };
  try {
    check();
    if (!("kind" in databaseClaim) || databaseClaim.kind !== "worker" || !databaseClaim.reader) {
      await release();
      return undefined;
    }
    const reader = databaseClaim.reader;
    // The requested locator may be a logical sessions.json marker. Only the
    // admitted reader supplies the physical owner used by creation and grants.
    const branch: ConversationKnowledgeBranch = {
      ...requestedBranch,
      storePath: reader.database.path,
    };
    const creation = await prepareConversationBranchCreation({
      branch,
      entry: params.sessionEntry,
      audience,
      reader,
      getRuntimeConfig: params.getRuntimeConfig,
      assertCurrent: params.assertCurrent,
      signal: params.signal,
    });
    cleanups.push(() => creation.release());
    check();
    const readRoot = () =>
      reader.withRead(
        {
          sessionKeys: [branch.root.sessionKey],
          transcript: {
            sessionKey: branch.root.sessionKey,
            entryIds: [],
            includeContextVersion: true,
          },
        },
        creation.source,
        (facts) => ({
          source: facts.source,
          entry: facts.entries.find((row) => row.sessionKey === branch.root.sessionKey)?.entry,
          version: facts.transcript?.contextVersion,
        }),
      );
    const beforeRoot = await readRoot();
    check();
    if (!beforeRoot.entry || !beforeRoot.version?.generation) {
      await release();
      return undefined;
    }
    const sources = await prepareConversationKnowledgeCheckpointSources({
      branch,
      participant: creation.participant,
      audience,
      reader,
      signal: params.signal ?? new AbortController().signal,
      assertCurrent: composeSessionSourceAssertion([check, creation.source]),
      getRuntimeConfig: params.getRuntimeConfig,
      targetCreation: creation,
      retainCleanup: (cleanup) => cleanups.push(cleanup),
    });
    // Cached bytes never carry permission. Reacquire current grants/ranges below.
    let warm: ReturnType<typeof readPreparedConversationKnowledgeRootProjection>;
    try {
      warm = readPreparedConversationKnowledgeRootProjection({
        branch,
        participant: creation.participant,
      });
    } catch {
      check();
    }
    const authority = { branch, source: sources.source(), signal: params.signal };
    let checkpoint = await readLatestConversationKnowledgeCheckpoint({
      ...authority,
      audienceKey: warm?.audienceKey ?? sources.audienceKey,
    });
    let coverage = checkpoint
      ? warm?.checkpoint?.checkpointId === checkpoint.checkpointId && warm.coverage
        ? warm.coverage
        : await readConversationKnowledgeCheckpointCoverage({ ...authority, checkpoint })
      : undefined;
    if (checkpoint && coverage) {
      checkpoint = selectConversationKnowledgeCheckpointBootstrap({
        checkpoint,
        coverage,
        branch,
        audienceKey: sources.audienceKey,
        progress: new Map(),
        availableReferences: sources.references,
      });
    }
    const claims: PreparedInitialSessionContextSourceClaim[] = [];
    if (checkpoint && coverage) {
      // A summary is indivisible: every original it covers needs fresh custody.
      for (const reference of sources.references) {
        if (!coverage.has(conversationKnowledgeContributionId(reference))) {
          continue;
        }
        const range = await sources.validate(reference);
        if (!range || !coverage.matchesReference(reference, range)) {
          checkpoint = undefined;
          coverage = undefined;
          claims.length = 0;
          break;
        }
        claims.push(range.claim);
      }
    }
    const cached = new Map(
      warm?.tail.map((value) => [conversationKnowledgeContributionId(value.reference), value]),
    );
    const packets: PreparedProjectedInitialSessionContext["projection"]["packets"][number][] = [];
    for (const reference of sources.references) {
      check();
      if (checkpoint && coverage?.has(conversationKnowledgeContributionId(reference))) {
        continue;
      }
      const prior = cached.get(conversationKnowledgeContributionId(reference));
      const valid =
        prior && isDeepStrictEqual(prior.reference, reference)
          ? await sources.validate(reference, prior.packet)
          : undefined;
      const fresh = valid ? undefined : await sources.read(reference);
      const packet = valid ? prior!.packet : fresh?.packet;
      const claim = valid?.claim ?? fresh?.claim;
      if (!packet || !claim) {
        continue;
      }
      const sourceClaim = claims.push(claim) - 1;
      packets.push({
        receipt: reference,
        text: packet.part.text,
        offset: 0,
        nextOffset: packet.part.nextOffset ?? 0,
        complete: packet.part.complete,
        sourceClaim,
      });
    }
    if (!packets.length && !checkpoint) {
      await release();
      return undefined;
    }
    const root = await readRoot();
    check();
    if (!root.entry || !root.version?.generation) {
      await release();
      return undefined;
    }
    const predicate: SessionSourcePredicate = {
      source: root.source,
      sessionKey: branch.root.sessionKey,
      fields: ["sessionId", "lifecycleRevision", "createdActor", "visibility", "incognito"],
      expected: root.entry,
      transcript: { sessionId: root.entry.sessionId, version: root.version, consistency: "prefix" },
    };
    const originalPrefix: SessionSourcePredicate = {
      ...predicate,
      transcript: {
        sessionId: beforeRoot.entry.sessionId,
        version: beforeRoot.version,
        consistency: "prefix",
      },
    };
    const projection = { branch, packets, claims, ...(checkpoint ? { checkpoint } : {}) };
    const context: PreparedProjectedInitialSessionContext = freezeJsonSnapshot({
      kind: "root-projection",
      source: root.source,
      sourceSessionKey: branch.root.sessionKey,
      sourceEntry: {
        sessionId: root.entry.sessionId,
        lifecycleRevision: root.entry.lifecycleRevision,
      },
      sourceVersion: root.version,
      targetSessionId: branch.sessionId,
      projection,
      events: createProjectedInitialSessionContextEvents({
        projection,
        targetSessionId: branch.sessionId,
      }),
    });
    const original = sources.source();
    const source = Object.assign(
      () => {
        check();
        original();
      },
      {
        prepareSessionSource: async () => {
          check();
          const prepared = await prepareSessionSourceAuthority(original);
          return {
            ...prepared,
            checks: [
              ...prepared.checks,
              ...[originalPrefix, predicate].map((rootPredicate) => ({
                predicate: rootPredicate,
                refuse: (): never => {
                  prepared.assertCurrent();
                  throw new Error("Initial projection root snapshot changed before creation");
                },
              })),
            ],
          };
        },
      },
    );
    source();
    return {
      context,
      source,
      bindCreation: (operation) => creation.bindCreation(operation),
      assertEntry: (entry) => creation.assertEntry(entry),
      release,
    };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Initial projection preparation failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
