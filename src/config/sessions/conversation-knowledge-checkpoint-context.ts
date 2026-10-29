import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readConversationKnowledgeCheckpoint,
  type ConversationKnowledgeCheckpoint,
  type PreparedConversationKnowledgeCheckpointCoverage,
} from "./conversation-knowledge-checkpoint.js";
import type {
  ConversationKnowledgeImportProgress,
  ConversationKnowledgePacketProgress,
} from "./conversation-knowledge-packets.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import type { CustomMessageReportAppend } from "./session-accessor.sqlite-transcript-reports.types.js";

export const CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT =
  "openclaw.conversation-knowledge-checkpoint-context.v1";

export type ConversationKnowledgeCheckpointContext = {
  version: 1;
  packetId: string;
  checkpointId: string;
  rootSessionId: string;
  rootLifecycleRevision: string;
  audienceKey: string;
  coverage: "summarized";
  summaryDigest: string;
};

function packetId(details: Omit<ConversationKnowledgeCheckpointContext, "packetId">): string {
  return sha256Hex(JSON.stringify([CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT, details]));
}

/** O(1) child receipt; exact summary coverage is prepared from immutable root records off-turn. */
export function readConversationKnowledgeCheckpointContext(
  value: unknown,
): ConversationKnowledgeCheckpointContext | undefined {
  const record = asOptionalRecord(value);
  if (
    record?.version !== 1 ||
    record.coverage !== "summarized" ||
    typeof record.checkpointId !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.checkpointId) ||
    typeof record.packetId !== "string" ||
    typeof record.rootSessionId !== "string" ||
    !record.rootSessionId.trim() ||
    typeof record.rootLifecycleRevision !== "string" ||
    !record.rootLifecycleRevision.trim() ||
    typeof record.audienceKey !== "string" ||
    !record.audienceKey.trim() ||
    typeof record.summaryDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.summaryDigest)
  ) {
    return undefined;
  }
  const details: Omit<ConversationKnowledgeCheckpointContext, "packetId"> = {
    version: 1,
    checkpointId: record.checkpointId,
    rootSessionId: record.rootSessionId,
    rootLifecycleRevision: record.rootLifecycleRevision,
    audienceKey: record.audienceKey,
    coverage: "summarized",
    summaryDigest: record.summaryDigest,
  };
  return record.packetId === packetId(details)
    ? { ...details, packetId: record.packetId }
    : undefined;
}

export function renderConversationKnowledgeCheckpointSummary(summary: string): string {
  return (
    "Summary of related conversations; quoted history, not a new request or proof of completed actions.\n" +
    summary
  );
}

/** One durable event owns both the model-visible summary and its exact native coverage receipt. */
export function createConversationKnowledgeCheckpointContext(params: {
  checkpoint: ConversationKnowledgeCheckpoint;
  branch: ConversationKnowledgeBranch;
}): CustomMessageReportAppend & { details: ConversationKnowledgeCheckpointContext } {
  const checkpoint = readConversationKnowledgeCheckpoint(params.checkpoint);
  if (
    !checkpoint ||
    checkpoint.root.agentId !== params.branch.agentId ||
    checkpoint.root.sessionId !== params.branch.root.sessionId ||
    checkpoint.root.lifecycleRevision !== params.branch.root.lifecycleRevision
  ) {
    throw new Error("Conversation checkpoint context root changed");
  }
  const details: Omit<ConversationKnowledgeCheckpointContext, "packetId"> = {
    version: 1,
    checkpointId: checkpoint.checkpointId,
    rootSessionId: checkpoint.root.sessionId,
    rootLifecycleRevision: checkpoint.root.lifecycleRevision,
    audienceKey: checkpoint.audienceKey,
    coverage: "summarized",
    summaryDigest: checkpoint.summaryDigest,
  };
  return {
    customType: CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT,
    display: false,
    content: renderConversationKnowledgeCheckpointSummary(checkpoint.summary),
    details: { ...details, packetId: packetId(details) },
  };
}

const summarizedProgress: ConversationKnowledgePacketProgress = Object.freeze({
  complete: true,
  nextOffset: 0,
  coverage: "summary",
});

/** Immutable packet overlay. Shared checkpoint membership is never expanded per recipient. */
class ConversationKnowledgeProgressView implements ReadonlyMap<
  string,
  ConversationKnowledgePacketProgress
> {
  readonly #packets: ReadonlyMap<string, ConversationKnowledgePacketProgress>;
  readonly #coverage: readonly PreparedConversationKnowledgeCheckpointCoverage[];
  readonly byteLength: number;
  readonly [Symbol.toStringTag] = "ConversationKnowledgeProgress";

  constructor(
    packets: ReadonlyMap<string, ConversationKnowledgePacketProgress>,
    coverage: readonly PreparedConversationKnowledgeCheckpointCoverage[],
  ) {
    this.#packets = new Map(
      [...packets].map(([id, progress]) => [id, Object.freeze({ ...progress })]),
    );
    this.#coverage = Object.freeze([...coverage]);
    // Only recipient-owned receipts/handles count here. Coverage belongs to the shared root proof.
    this.byteLength = Buffer.byteLength(JSON.stringify([...this.#packets])) + coverage.length * 80;
    Object.freeze(this);
  }
  get(id: string): ConversationKnowledgePacketProgress | undefined {
    const exact = this.#packets.get(id);
    if (exact?.complete) return exact;
    return this.#coverage.some((coverage) => coverage.has(id)) ? summarizedProgress : exact;
  }
  has(id: string): boolean {
    return this.#packets.has(id) || this.#coverage.some((coverage) => coverage.has(id));
  }
  *keys(): MapIterator<string> {
    yield* this.#packets.keys();
    for (let index = 0; index < this.#coverage.length; index++) {
      for (const id of this.#coverage[index]!.contributionIds()) {
        if (
          !this.#packets.has(id) &&
          !this.#coverage.slice(0, index).some((coverage) => coverage.has(id))
        )
          yield id;
      }
    }
  }
  *entries(): MapIterator<[string, ConversationKnowledgePacketProgress]> {
    for (const id of this.keys()) yield [id, this.get(id)!];
  }
  *values(): MapIterator<ConversationKnowledgePacketProgress> {
    for (const id of this.keys()) yield this.get(id)!;
  }
  [Symbol.iterator](): MapIterator<[string, ConversationKnowledgePacketProgress]> {
    return this.entries();
  }
  forEach(
    callback: (
      value: ConversationKnowledgePacketProgress,
      key: string,
      map: ReadonlyMap<string, ConversationKnowledgePacketProgress>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [id, value] of this.entries()) callback.call(thisArg, value, id, this);
  }
  get size(): number {
    // Enumeration is explicit/diagnostic only; normal admission uses get/has.
    if (this.#coverage.length === 1) {
      const coverage = this.#coverage[0]!;
      let size = coverage.size;
      for (const id of this.#packets.keys()) if (!coverage.has(id)) size++;
      return size;
    }
    let size = 0;
    for (const _id of this.keys()) size++;
    return size;
  }
}

/** Preserve shared immutable membership when caching; never structuredClone a private proof. */
export function snapshotConversationKnowledgeProgress(
  progress: ReadonlyMap<string, ConversationKnowledgePacketProgress>,
): { progress: ReadonlyMap<string, ConversationKnowledgePacketProgress>; byteLength: number } {
  const view =
    progress instanceof ConversationKnowledgeProgressView
      ? progress
      : new ConversationKnowledgeProgressView(progress, []);
  return { progress: view, byteLength: view.byteLength };
}

/** Apply already prepared membership; this must not perform source reads or model work. */
export function resolveConversationKnowledgeImportProgress(params: {
  branch: ConversationKnowledgeBranch;
  imports: ConversationKnowledgeImportProgress;
  checkpointCoverage?: ReadonlyMap<string, PreparedConversationKnowledgeCheckpointCoverage>;
}): ReadonlyMap<string, ConversationKnowledgePacketProgress> {
  const coverages: PreparedConversationKnowledgeCheckpointCoverage[] = [];
  for (const checkpoint of params.imports.checkpoints) {
    if (
      checkpoint.rootSessionId !== params.branch.root.sessionId ||
      checkpoint.rootLifecycleRevision !== params.branch.root.lifecycleRevision
    ) {
      throw new Error("Conversation checkpoint progress belongs to another root");
    }
    const coverage = params.checkpointCoverage?.get(checkpoint.checkpointId);
    if (!coverage) {
      throw new Error("Conversation checkpoint coverage is not prepared");
    }
    coverage.assertCheckpoint({
      checkpointId: checkpoint.checkpointId,
      audienceKey: checkpoint.audienceKey,
      summaryDigest: checkpoint.summaryDigest,
      root: {
        agentId: params.branch.agentId,
        sessionId: checkpoint.rootSessionId,
        lifecycleRevision: checkpoint.rootLifecycleRevision,
      },
    });
    coverages.push(coverage);
  }
  return coverages.length
    ? new ConversationKnowledgeProgressView(params.imports.packets, coverages)
    : new Map(params.imports.packets);
}
