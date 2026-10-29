import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { conversationKnowledgeParticipantIdentity } from "./conversation-audience.js";
import { conversationKnowledgeContributionId } from "./conversation-knowledge-identity.js";
import type { ConversationKnowledgePacketProgress } from "./conversation-knowledge-packets.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import {
  readConversationKnowledgeReceipt,
  readConversationUtteranceObservation,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import type {
  CustomMessageReport,
  CustomMessageReportAppend,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export const CONVERSATION_KNOWLEDGE_CHECKPOINT = "openclaw.conversation-knowledge-checkpoint.v1";
/** Derived view; original references and histories remain authoritative and are never deleted. */
export type ConversationKnowledgeCheckpoint = {
  version: 1;
  checkpointId: string;
  audienceKey: string;
  root: { agentId: string; sessionId: string; lifecycleRevision: string };
  previousCheckpointId: string | null;
  summary: string;
  summaryDigest: string;
  /** Only newly summarized exact occurrences; prior coverage belongs to the immutable predecessor. */
  coveredContributionIds: string[];
  /** Aligned with delta IDs; binds immutable original anchors, including lower bound/generation. */
  coveredRangeDigests: string[];
};
type CheckpointContent = Omit<ConversationKnowledgeCheckpoint, "checkpointId">;
export type ConversationKnowledgeCheckpointIdentity = Pick<
  ConversationKnowledgeCheckpoint,
  "checkpointId" | "audienceKey" | "root" | "summaryDigest"
>;
const validText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const validDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const checkpointId = (value: CheckpointContent): string => sha256Hex(JSON.stringify(value));
function canonicalReference(value: unknown): ConversationKnowledgeReference | undefined {
  return readConversationUtteranceObservation(value) ?? readConversationKnowledgeReceipt(value);
}
export function conversationKnowledgeCheckpointRangeDigest(
  reference: ConversationKnowledgeReference,
  range?: { through: TranscriptEntryAnchor; from?: TranscriptEntryAnchor },
): string {
  const anchor = (value: TranscriptEntryAnchor | undefined) =>
    value
      ? [
          value.agentId,
          value.sessionKey,
          value.sessionId,
          value.storePath,
          value.generation,
          value.entryId,
          value.rawSeq,
          value.activeMessagePosition,
          value.effectiveParentId,
        ]
      : null;
  return sha256Hex(
    JSON.stringify([
      [
        reference.source.agentId,
        reference.source.sessionKey,
        reference.source.sessionId,
        reference.source.lifecycleRevision,
      ],
      anchor(range?.through ?? reference.through),
      anchor(range ? range.from : reference.privateAudience?.admission),
    ]),
  );
}
/** Persisted metadata proves exact coverage, never permission to read a source. */
export function readConversationKnowledgeCheckpoint(
  value: unknown,
): ConversationKnowledgeCheckpoint | undefined {
  const record = asOptionalRecord(value);
  const root = asOptionalRecord(record?.root);
  if (
    record?.version !== 1 ||
    !validDigest(record.checkpointId) ||
    !validText(record.audienceKey) ||
    !validText(record.summary) ||
    !validDigest(record.summaryDigest) ||
    record.summaryDigest !== sha256Hex(record.summary) ||
    !root ||
    !validText(root.agentId) ||
    !validText(root.sessionId) ||
    !validText(root.lifecycleRevision) ||
    (record.previousCheckpointId !== null && !validDigest(record.previousCheckpointId)) ||
    !Array.isArray(record.coveredContributionIds) ||
    record.coveredContributionIds.length === 0 ||
    !Array.isArray(record.coveredRangeDigests) ||
    record.coveredRangeDigests.length !== record.coveredContributionIds.length ||
    record.coveredRangeDigests.some((value: unknown) => !validDigest(value))
  )
    return undefined;
  const ids = new Set<string>();
  for (const id of record.coveredContributionIds) {
    if (!validDigest(id) || ids.has(id)) return undefined;
    ids.add(id);
  }
  const content: CheckpointContent = {
    version: 1,
    audienceKey: record.audienceKey,
    root: {
      agentId: root.agentId,
      sessionId: root.sessionId,
      lifecycleRevision: root.lifecycleRevision,
    },
    previousCheckpointId: record.previousCheckpointId,
    summary: record.summary,
    summaryDigest: record.summaryDigest,
    coveredContributionIds: [...ids],
    coveredRangeDigests: [...record.coveredRangeDigests],
  };
  return checkpointId(content) === record.checkpointId
    ? { ...content, checkpointId: record.checkpointId }
    : undefined;
}
const coverageIssuer = Symbol("conversation-checkpoint-coverage");
/** Background-prepared exact membership. Never serialized into a child or model context. */
export class PreparedConversationKnowledgeCheckpointCoverage {
  readonly #checkpoint: ConversationKnowledgeCheckpointIdentity;
  readonly #ids: ReadonlyMap<string, string>;
  constructor(
    issuer: typeof coverageIssuer,
    checkpoint: ConversationKnowledgeCheckpointIdentity,
    ids: ReadonlyMap<string, string>,
  ) {
    if (issuer !== coverageIssuer)
      throw new Error("Checkpoint coverage must be prepared from an immutable chain");
    this.#checkpoint = {
      checkpointId: checkpoint.checkpointId,
      audienceKey: checkpoint.audienceKey,
      root: { ...checkpoint.root },
      summaryDigest: checkpoint.summaryDigest,
    };
    this.#ids = new Map(ids);
    Object.freeze(this);
  }
  assertCheckpoint(checkpoint: ConversationKnowledgeCheckpointIdentity): void {
    if (
      this.#checkpoint.checkpointId !== checkpoint.checkpointId ||
      this.#checkpoint.audienceKey !== checkpoint.audienceKey ||
      this.#checkpoint.summaryDigest !== checkpoint.summaryDigest ||
      !isDeepStrictEqual(this.#checkpoint.root, checkpoint.root)
    ) {
      throw new Error("Prepared checkpoint coverage does not match its recipient reference");
    }
  }
  has(id: string): boolean {
    return this.#ids.has(id);
  }
  get size(): number {
    return this.#ids.size;
  }
  contributionIds(): IterableIterator<string> {
    return this.#ids.keys();
  }
  matchesReference(
    reference: ConversationKnowledgeReference,
    range?: { through: TranscriptEntryAnchor; from?: TranscriptEntryAnchor },
  ): boolean {
    const canonical = canonicalReference(reference);
    if (
      !canonical ||
      this.#ids.get(conversationKnowledgeContributionId(canonical)) !==
        conversationKnowledgeCheckpointRangeDigest(canonical)
    )
      return false;
    // Root-attested readRange may renew only generation, never move the original interval.
    // This is data compatibility, not a grant: callers still validate native current anchors.
    return (
      !range ||
      conversationKnowledgeCheckpointRangeDigest(canonical, range) ===
        conversationKnowledgeCheckpointRangeDigest(canonical, {
          through: canonical.readRange?.through ?? canonical.through,
          from: canonical.readRange?.admission ?? canonical.privateAudience?.admission,
        })
    );
  }
}
/** Background only: validate a fixed root snapshot once; missing/corrupt/cyclic links fail closed. */
export function prepareConversationKnowledgeCheckpointCoverage(params: {
  checkpoint: ConversationKnowledgeCheckpoint;
  records: readonly ConversationKnowledgeCheckpoint[];
  assertCurrent: () => void;
}): PreparedConversationKnowledgeCheckpointCoverage {
  params.assertCurrent();
  const head = readConversationKnowledgeCheckpoint(params.checkpoint);
  if (!head) throw new Error("Conversation checkpoint head is invalid");
  const byId = new Map<string, ConversationKnowledgeCheckpoint>();
  for (const raw of params.records) {
    params.assertCurrent();
    const record = readConversationKnowledgeCheckpoint(raw);
    if (!record) throw new Error("Conversation checkpoint chain contains an invalid record");
    byId.set(record.checkpointId, record);
  }
  const seen = new Set<string>();
  const ids = new Map<string, string>();
  let id: string | null = head.checkpointId;
  while (id !== null) {
    params.assertCurrent();
    const record = byId.get(id);
    if (
      !record ||
      seen.has(id) ||
      record.audienceKey !== head.audienceKey ||
      !isDeepStrictEqual(record.root, head.root)
    ) {
      throw new Error("Conversation checkpoint chain is missing, cyclic, or outside its audience");
    }
    seen.add(id);
    for (const [index, contributionId] of record.coveredContributionIds.entries()) {
      if (ids.has(contributionId))
        throw new Error("Conversation checkpoint chain repeats an already summarized occurrence");
      ids.set(contributionId, record.coveredRangeDigests[index]!);
    }
    id = record.previousCheckpointId;
  }
  params.assertCurrent();
  return new PreparedConversationKnowledgeCheckpointCoverage(coverageIssuer, head, ids);
}
export function createConversationKnowledgeCheckpoint(params: {
  branch: ConversationKnowledgeBranch;
  audienceKey: string;
  summary: string;
  covered: readonly ConversationKnowledgeReference[];
  previous?: ConversationKnowledgeCheckpoint;
  previousCoverage?: PreparedConversationKnowledgeCheckpointCoverage;
}): ConversationKnowledgeCheckpoint {
  const root = {
    agentId: params.branch.agentId,
    sessionId: params.branch.root.sessionId,
    lifecycleRevision: params.branch.root.lifecycleRevision,
  };
  const previous = params.previous && readConversationKnowledgeCheckpoint(params.previous);
  if (
    params.previous &&
    (!previous ||
      previous.audienceKey !== params.audienceKey ||
      !isDeepStrictEqual(previous.root, root) ||
      !params.previousCoverage)
  ) {
    throw new Error("Conversation checkpoint predecessor or prepared coverage changed");
  }
  if (previous) params.previousCoverage!.assertCheckpoint(previous);
  else if (params.previousCoverage)
    throw new Error("Conversation checkpoint coverage has no predecessor");
  const ids = new Set<string>();
  const ranges: string[] = [];
  for (const raw of params.covered) {
    const reference = canonicalReference(raw);
    if (
      !reference ||
      reference.retirement ||
      reference.source.agentId !== root.agentId ||
      conversationKnowledgeParticipantIdentity(reference.privateAudience?.participant) !==
        params.audienceKey
    ) {
      throw new Error("Conversation checkpoint has invalid or mixed-audience coverage");
    }
    const id = conversationKnowledgeContributionId(reference);
    if (ids.has(id) || params.previousCoverage?.has(id))
      throw new Error("Conversation checkpoint cannot repeat previously summarized occurrences");
    ids.add(id);
    ranges.push(conversationKnowledgeCheckpointRangeDigest(reference));
  }
  const content: CheckpointContent = {
    version: 1,
    audienceKey: params.audienceKey,
    root,
    previousCheckpointId: previous?.checkpointId ?? null,
    summary: params.summary,
    summaryDigest: sha256Hex(params.summary),
    coveredContributionIds: [...ids],
    coveredRangeDigests: ranges,
  };
  const result = readConversationKnowledgeCheckpoint({
    ...content,
    checkpointId: checkpointId(content),
  });
  if (!result) throw new Error("Conversation checkpoint has invalid or empty coverage");
  return result;
}
/** Native report selection may retry. Equal writes are idempotent; stale writers lose CAS. */
export function selectConversationKnowledgeCheckpointReport(
  checkpoint: ConversationKnowledgeCheckpoint,
  latest: CustomMessageReport | undefined,
  previousCoverage?: PreparedConversationKnowledgeCheckpointCoverage,
): CustomMessageReportAppend | undefined {
  const validated = readConversationKnowledgeCheckpoint(checkpoint);
  const previous = latest && readConversationKnowledgeCheckpoint(latest.details);
  if (
    !validated ||
    (latest && (!previous || latest.customType !== CONVERSATION_KNOWLEDGE_CHECKPOINT))
  )
    throw new Error("Conversation checkpoint record is invalid");
  if (previous?.checkpointId === validated.checkpointId) return undefined;
  if (
    (previous?.checkpointId ?? null) !== validated.previousCheckpointId ||
    (previous &&
      (previous.audienceKey !== validated.audienceKey ||
        !isDeepStrictEqual(previous.root, validated.root)))
  ) {
    throw new Error("Conversation checkpoint predecessor changed before commit");
  }
  if (previous) {
    if (!previousCoverage)
      throw new Error("Conversation checkpoint predecessor coverage is not prepared");
    previousCoverage.assertCheckpoint(previous);
    if (validated.coveredContributionIds.some((id) => previousCoverage.has(id))) {
      throw new Error("Conversation checkpoint cannot repeat previously summarized occurrences");
    }
  }
  return {
    customType: CONVERSATION_KNOWLEDGE_CHECKPOINT,
    display: false,
    content: "Derived private conversation checkpoint; no task was executed.",
    details: validated,
  };
}
/** Bootstrap only; existing receivers retain precise missing ranges and native compaction. */
export function selectConversationKnowledgeCheckpointBootstrap(params: {
  checkpoint: ConversationKnowledgeCheckpoint;
  coverage: PreparedConversationKnowledgeCheckpointCoverage;
  branch: ConversationKnowledgeBranch;
  audienceKey: string;
  progress: ReadonlyMap<string, ConversationKnowledgePacketProgress>;
  hasCheckpointReceipt?: boolean;
  availableReferences: readonly ConversationKnowledgeReference[];
}): ConversationKnowledgeCheckpoint | undefined {
  if (params.progress.size !== 0 || params.hasCheckpointReceipt) return undefined;
  const checkpoint = readConversationKnowledgeCheckpoint(params.checkpoint);
  if (
    !checkpoint ||
    checkpoint.audienceKey !== params.audienceKey ||
    checkpoint.root.agentId !== params.branch.agentId ||
    checkpoint.root.sessionId !== params.branch.root.sessionId ||
    checkpoint.root.lifecycleRevision !== params.branch.root.lifecycleRevision
  )
    return undefined;
  params.coverage.assertCheckpoint(checkpoint);
  const available = new Map<string, ConversationKnowledgeReference>();
  for (const raw of params.availableReferences) {
    const reference = canonicalReference(raw);
    if (reference) available.set(conversationKnowledgeContributionId(reference), reference);
  }
  for (const id of params.coverage.contributionIds()) {
    const reference = available.get(id);
    if (
      !reference ||
      reference.retirement ||
      reference.source.agentId !== params.branch.agentId ||
      (reference.source.sessionId === params.branch.sessionId &&
        reference.source.sessionKey === params.branch.sessionKey &&
        reference.source.lifecycleRevision === params.branch.lifecycleRevision) ||
      !params.coverage.matchesReference(reference) ||
      conversationKnowledgeParticipantIdentity(reference.privateAudience?.participant) !==
        params.audienceKey
    )
      return undefined;
  }
  return checkpoint;
}
