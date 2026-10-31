import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { assertModelSelectionUnlocked } from "../../sessions/model-overrides.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { conversationKnowledgeCheckpointRangeDigest } from "./conversation-knowledge-checkpoint.js";
import {
  conversationKnowledgeContributionId,
  conversationKnowledgePacketId,
} from "./conversation-knowledge-identity.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import {
  createProjectedInitialSessionContextEvents,
  type PreparedInitialSessionContext,
  type PreparedProjectedInitialSessionContext,
} from "./session-initial-context.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

function assertInitialRootProjection(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
  context: PreparedProjectedInitialSessionContext,
): void {
  const { projection } = context;
  const { branch } = projection;
  const topology = entry.conversationTopology;
  const header = asOptionalRecord(context.events[0]);
  if (
    branch.agentId !== database.agentId ||
    normalizeStoreSessionKey(branch.sessionKey) !== normalizeStoreSessionKey(sessionKey) ||
    branch.sessionId !== entry.sessionId ||
    branch.lifecycleRevision !== entry.lifecycleRevision ||
    branch.root.sessionId !== context.sourceEntry.sessionId ||
    branch.root.lifecycleRevision !== context.sourceEntry.lifecycleRevision ||
    normalizeStoreSessionKey(branch.root.sessionKey) !==
      normalizeStoreSessionKey(context.sourceSessionKey) ||
    topology?.role !== "branch" ||
    topology.rootSessionKey !== branch.root.sessionKey ||
    topology.rootSessionId !== branch.root.sessionId ||
    topology.rootSessionLifecycleRevision !== branch.root.lifecycleRevision ||
    entry.forkSource ||
    typeof header?.timestamp !== "string" ||
    typeof header.cwd !== "string" ||
    !projection.claims.length
  ) {
    throw new Error("Initial root projection does not match its admitted root and target.");
  }
  if (
    !isDeepStrictEqual(
      context.events,
      createProjectedInitialSessionContextEvents({
        projection,
        targetSessionId: context.targetSessionId,
        timestamp: header.timestamp,
        cwd: header.cwd,
      }),
    )
  ) {
    throw new Error("Initial root projection changed its canonical observation carriers.");
  }
  const validatedPrefixes = new Set<string>();
  for (const claim of projection.claims) {
    assertCapturedSessionEntryReadSource(claim.predicate.source, database);
    const current = readExactSessionEntryRow(database, claim.predicate.sessionKey)?.entry;
    if (!current) {
      throw new Error("Initial root projection donor is unavailable.");
    }
    assertModelSelectionUnlocked(current);
    const scope = {
      agentId: database.agentId,
      path: database.path,
      sessionKey: claim.predicate.sessionKey,
      sessionId: claim.sessionId,
    };
    // Range anchors and the captured prefix are independent: an unchanged old
    // anchor alone must not admit a source reset or navigation after preparation.
    const prefix = JSON.stringify([scope.sessionKey, scope.sessionId, claim.version]);
    if (!validatedPrefixes.has(prefix)) {
      validateSessionTranscriptContextInDatabase(
        database,
        scope,
        { version: claim.version },
        "prefix",
      );
      validatedPrefixes.add(prefix);
    }
    if (claim.through) {
      validateSessionTranscriptContextInDatabase(database, scope, {
        through: claim.through,
        from: claim.from,
      });
    } else if (claim.from) {
      throw new Error("Initial root projection donor range has no completed endpoint.");
    }
  }
  const packetIds = new Set<string>();
  for (const packet of projection.packets) {
    const claim = projection.claims[packet.sourceClaim];
    const packetId = conversationKnowledgePacketId(
      conversationKnowledgeContributionId(packet.receipt),
      packet.offset,
    );
    if (
      !Number.isSafeInteger(packet.sourceClaim) ||
      !claim ||
      claim.predicate.source.agentId !== packet.receipt.source.agentId ||
      normalizeStoreSessionKey(claim.predicate.sessionKey) !==
        normalizeStoreSessionKey(packet.receipt.source.sessionKey) ||
      !isDeepStrictEqual(claim.reference, packet.receipt) ||
      !claim.through ||
      claim.sessionId !== claim.through.sessionId ||
      !Number.isSafeInteger(packet.offset) ||
      packet.offset < 0 ||
      !Number.isSafeInteger(packet.nextOffset) ||
      packet.nextOffset < packet.offset ||
      packetIds.has(packetId)
    ) {
      throw new Error("Initial root projection packet lost its exact prepared donor range.");
    }
    packetIds.add(packetId);
  }
  if (projection.checkpoint) {
    const covered = new Map(
      projection.claims.map((claim) => [
        conversationKnowledgeContributionId(claim.reference),
        claim,
      ]),
    );
    for (const [index, id] of projection.checkpoint.coveredContributionIds.entries()) {
      const claim = covered.get(id);
      if (
        !claim?.through ||
        conversationKnowledgeCheckpointRangeDigest(claim.reference, {
          through: claim.through,
          from: claim.from,
        }) !== projection.checkpoint.coveredRangeDigests[index]
      ) {
        throw new Error("Initial root checkpoint lost its exact prepared donor coverage.");
      }
    }
  }
}

/** Only the native lifecycle worker can copy into an absent-to-created transcript. */
export function appendInitialSessionContextInTransaction(
  database: OpenClawAgentDatabase,
  params: {
    sessionKey: string;
    entry: SessionEntry;
    context: PreparedInitialSessionContext;
  },
): void {
  if (isMainThread) {
    throw new Error("Initial conversation context requires the native lifecycle worker.");
  }
  const { context, entry } = params;
  const sourceKey = normalizeStoreSessionKey(context.sourceSessionKey);
  const header = asOptionalRecord(context.events[0]);
  if (
    !sourceKey ||
    sourceKey === normalizeStoreSessionKey(params.sessionKey) ||
    context.sourceEntry.sessionId === entry.sessionId ||
    context.targetSessionId !== entry.sessionId ||
    (context.kind !== "root-projection" &&
      (entry.forkSource?.sessionKey !== sourceKey ||
        entry.forkSource?.sessionId !== context.sourceEntry.sessionId ||
        entry.forkSource?.entryId !== context.sourceThrough?.entryId)) ||
    header?.type !== "session" ||
    header.id !== entry.sessionId
  ) {
    throw new Error("Initial conversation context does not match its admitted source and target.");
  }
  assertCapturedSessionEntryReadSource(context.source, database);
  const source = readExactSessionEntryRow(database, sourceKey)?.entry;
  if (
    !source ||
    source.sessionId !== context.sourceEntry.sessionId ||
    source.lifecycleRevision !== context.sourceEntry.lifecycleRevision
  ) {
    throw new Error("Initial conversation context source changed before creation.");
  }
  assertModelSelectionUnlocked(source);
  // A busy source may append after preparation. Native prefix validation also
  // rejects navigation changes, not just generation changes or a lower sequence.
  validateSessionTranscriptContextInDatabase(
    database,
    {
      agentId: database.agentId,
      path: database.path,
      sessionKey: sourceKey,
      sessionId: source.sessionId,
    },
    { version: context.sourceVersion },
    "prefix",
  );
  if (context.sourceThrough) {
    validateSessionTranscriptContextInDatabase(
      database,
      {
        agentId: database.agentId,
        path: database.path,
        sessionKey: sourceKey,
        sessionId: source.sessionId,
      },
      { through: context.sourceThrough },
    );
  }
  if (context.kind === "root-projection") {
    assertInitialRootProjection(database, params.sessionKey, entry, context);
  }
  // A missing visible row does not imply an unused transcript/window identity.
  const window = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_windows")
      .select("session_id")
      .where("session_id", "=", entry.sessionId),
  );
  const target = readTranscriptContextVersionInTransaction(database, entry.sessionId);
  if (window || target.generation !== null || target.rawSeq !== null) {
    throw new Error("Initial conversation context requires an unused target transcript.");
  }
  appendTranscriptEventsInTransaction(
    database,
    {
      agentId: database.agentId,
      path: database.path,
      sessionKey: params.sessionKey,
      sessionId: entry.sessionId,
    },
    context.events,
  );
}
