import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CONVERSATION_KNOWLEDGE_CHECKPOINT,
  readConversationKnowledgeCheckpoint,
  selectConversationKnowledgeCheckpointReport,
  type ConversationKnowledgeCheckpoint,
  prepareConversationKnowledgeCheckpointCoverage,
  type PreparedConversationKnowledgeCheckpointCoverage,
} from "./conversation-knowledge-checkpoint.js";
import { readConversationKnowledgeReports } from "./conversation-knowledge-history.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import {
  appendSessionTranscriptReport,
  readSessionTranscriptReportReceipts,
} from "./session-accessor.sqlite-transcript-reports.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";

// Weak values share immutable provenance between live owners. Bounded keys do not
// keep old roots alive; eviction affects preparation cost, never authorization.
const sharedCoverage = new Map<string, WeakRef<PreparedConversationKnowledgeCheckpointCoverage>>();
const MAX_SHARED_COVERAGE_KEYS = 128;

type CheckpointAuthority = {
  branch: ConversationKnowledgeBranch;
  /** Must retain current root, audience, and exact contributing-source authority through commit. */
  source: SessionSourceAssertion;
  signal?: AbortSignal;
};

function rootTarget(branch: ConversationKnowledgeBranch) {
  return {
    agentId: branch.agentId,
    storePath: branch.storePath,
    sessionKey: branch.root.sessionKey,
    sessionId: branch.root.sessionId,
    expectedLifecycleRevision: branch.root.lifecycleRevision,
  };
}

function check(params: CheckpointAuthority) {
  params.signal?.throwIfAborted();
  params.source();
}

/** Exact historical head for an already admitted receipt, not the latest audience summary. */
export async function readConversationKnowledgeCheckpointById(
  params: CheckpointAuthority & { checkpointId: string },
): Promise<ConversationKnowledgeCheckpoint> {
  check(params);
  const result = await readSessionTranscriptReportReceipts(
    rootTarget(params.branch),
    [
      {
        customType: CONVERSATION_KNOWLEDGE_CHECKPOINT,
        receipt: { field: "checkpointId", value: params.checkpointId },
      },
    ],
    { source: params.source },
  );
  check(params);
  if (!result.ok) {
    throw new Error("Conversation checkpoint receipt read was refused", { cause: result.error });
  }
  const observation = result.value[0];
  const checkpoint =
    observation && observation.status !== "missing"
      ? readConversationKnowledgeCheckpoint(observation.report.details)
      : undefined;
  if (
    !checkpoint ||
    checkpoint.checkpointId !== params.checkpointId ||
    checkpoint.root.agentId !== params.branch.agentId ||
    checkpoint.root.sessionId !== params.branch.root.sessionId ||
    checkpoint.root.lifecycleRevision !== params.branch.root.lifecycleRevision
  ) {
    throw new Error("Admitted conversation checkpoint is unavailable in its original root");
  }
  return checkpoint;
}

/** Background-only fixed-prefix resolution. Cache the returned proof at the preparation owner. */
export async function readConversationKnowledgeCheckpointCoverage(
  params: CheckpointAuthority & {
    checkpoint: ConversationKnowledgeCheckpoint;
    reader?: SessionEntryCohortReader;
  },
): Promise<PreparedConversationKnowledgeCheckpointCoverage> {
  check(params);
  const key =
    params.reader &&
    (await params.reader.withRead(
      // The admitted cohort's original recipient must remain selected: its
      // native expected-session fence applies even when only root metadata is used.
      { sessionKeys: [params.branch.sessionKey, params.branch.root.sessionKey] },
      params.source,
      (read) => {
        const recipient = read.entries.find(
          (row) => row.sessionKey === params.branch.sessionKey,
        )?.entry;
        const root = read.entries.find(
          (row) => row.sessionKey === params.branch.root.sessionKey,
        )?.entry;
        if (
          recipient?.sessionId !== params.branch.sessionId ||
          recipient.lifecycleRevision !== params.branch.lifecycleRevision ||
          root?.sessionId !== params.branch.root.sessionId ||
          root.lifecycleRevision !== params.branch.root.lifecycleRevision
        )
          throw new Error("Conversation checkpoint root changed before coverage preparation");
        if (typeof read.source.databaseIdentity !== "string") return undefined;
        return JSON.stringify([
          read.source,
          params.branch.agentId,
          params.branch.root,
          params.checkpoint.audienceKey,
          params.checkpoint.checkpointId,
        ]);
      },
    ));
  check(params);
  const cached = key ? sharedCoverage.get(key)?.deref() : undefined;
  if (cached) {
    // Current root custody and an exact native head read are still mandatory.
    const head = await readConversationKnowledgeCheckpointById({
      ...params,
      checkpointId: params.checkpoint.checkpointId,
    });
    cached.assertCheckpoint(head);
    cached.assertCheckpoint(params.checkpoint);
    check(params);
    return cached;
  }
  const events = await readConversationKnowledgeReports({
    target: rootTarget(params.branch),
    customTypes: [CONVERSATION_KNOWLEDGE_CHECKPOINT],
    detailsOnly: true,
    assertCurrent: () => check(params),
    signal: params.signal,
  });
  const records: ConversationKnowledgeCheckpoint[] = [];
  for (const event of events) {
    const details = asOptionalRecord(asOptionalRecord(event)?.details);
    if (details?.audienceKey !== params.checkpoint.audienceKey) continue;
    const record = readConversationKnowledgeCheckpoint(details);
    if (!record)
      throw new Error("Conversation checkpoint chain contains invalid persisted metadata");
    records.push(record);
  }
  check(params);
  const coverage = prepareConversationKnowledgeCheckpointCoverage({
    checkpoint: params.checkpoint,
    records,
    assertCurrent: () => check(params),
  });
  if (key) {
    for (const [oldKey, value] of sharedCoverage) if (!value.deref()) sharedCoverage.delete(oldKey);
    // A concurrent reader may already own this exact immutable content.
    const existing = sharedCoverage.get(key)?.deref();
    if (existing) {
      existing.assertCheckpoint(params.checkpoint);
      return existing;
    }
    sharedCoverage.set(key, new WeakRef(coverage));
    while (sharedCoverage.size > MAX_SHARED_COVERAGE_KEYS)
      sharedCoverage.delete(sharedCoverage.keys().next().value!);
  }
  return coverage;
}

/** Reads the exact audience head through the native worker; it does not grant disclosure. */
export async function readLatestConversationKnowledgeCheckpoint(
  params: CheckpointAuthority & { audienceKey: string },
): Promise<ConversationKnowledgeCheckpoint | undefined> {
  check(params);
  const result = await readSessionTranscriptReportReceipts(
    rootTarget(params.branch),
    [
      {
        customType: CONVERSATION_KNOWLEDGE_CHECKPOINT,
        receipt: { field: "audienceKey", value: params.audienceKey },
      },
    ],
    { source: params.source },
  );
  check(params);
  if (!result.ok) {
    throw new Error("Conversation checkpoint read was refused", { cause: result.error });
  }
  const observation = result.value[0];
  if (!observation || observation.status === "missing") {
    return undefined;
  }
  const checkpoint = readConversationKnowledgeCheckpoint(observation.report.details);
  if (
    !checkpoint ||
    checkpoint.audienceKey !== params.audienceKey ||
    checkpoint.root.agentId !== params.branch.agentId ||
    checkpoint.root.sessionId !== params.branch.root.sessionId ||
    checkpoint.root.lifecycleRevision !== params.branch.root.lifecycleRevision
  ) {
    throw new Error("Conversation checkpoint belongs to a different root or audience");
  }
  return checkpoint;
}

/** Publication is an immutable native report CAS; original references and histories remain intact. */
export async function appendConversationKnowledgeCheckpoint(
  params: CheckpointAuthority & {
    checkpoint: ConversationKnowledgeCheckpoint;
    previousCoverage?: PreparedConversationKnowledgeCheckpointCoverage;
  },
): Promise<void> {
  check(params);
  const checkpoint = readConversationKnowledgeCheckpoint(params.checkpoint);
  if (
    !checkpoint ||
    checkpoint.root.agentId !== params.branch.agentId ||
    checkpoint.root.sessionId !== params.branch.root.sessionId ||
    checkpoint.root.lifecycleRevision !== params.branch.root.lifecycleRevision
  ) {
    throw new Error("Conversation checkpoint publication root changed");
  }
  const result = await appendSessionTranscriptReport(
    rootTarget(params.branch),
    {
      kind: "custom",
      customTypes: [CONVERSATION_KNOWLEDGE_CHECKPOINT],
      receipt: { field: "audienceKey", value: checkpoint.audienceKey },
      selectReport: (latest) =>
        selectConversationKnowledgeCheckpointReport(checkpoint, latest, params.previousCoverage),
    },
    { source: params.source },
  );
  check(params);
  if (!result.ok) {
    throw new Error("Conversation checkpoint publication was refused", { cause: result.error });
  }
}
