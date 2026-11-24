import { isDeepStrictEqual } from "node:util";
import {
  sameConversationKnowledgeCheckpointRange,
  type PreparedConversationKnowledgeCheckpointCoverage,
} from "../../config/sessions/conversation-knowledge-checkpoint.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import { MAX_SESSION_MODEL_CONTEXT_BATCH_RANGES } from "../../config/sessions/session-model-context-batch-limits.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { PreparedRootKnowledgeContribution } from "./conversation-knowledge-checkpoint-range.js";

/** Disposable text cache only; its contents never grant disclosure or replace native receipts. */
export function createConversationKnowledgeCheckpointTail() {
  const entries = new Map<
    string,
    { referenceKey: string; value: PreparedRootKnowledgeContribution; bytes: number; order: number }
  >();
  let bytes = 0;
  let revision = 0;
  let projection:
    | readonly Pick<PreparedRootKnowledgeContribution, "reference" | "packet">[]
    | undefined;
  const evict = (id: string) => {
    const entry = entries.get(id);
    if (!entry) {
      return false;
    }
    bytes -= entry.bytes;
    entries.delete(id);
    projection = undefined;
    revision++;
    return true;
  };
  const lookup = (
    reference: ConversationKnowledgeReference | undefined,
    published: ReadonlyMap<string, PreparedRootKnowledgeContribution>,
    id = reference && conversationKnowledgeContributionId(reference),
  ) => {
    if (!id || !reference) {
      return undefined;
    }
    const previous = published.get(id);
    return (
      entries.get(id)?.value ??
      (isDeepStrictEqual(previous?.reference, reference) ? previous : undefined)
    );
  };
  return {
    get revision() {
      return revision;
    },
    changed() {
      revision++;
    },
    get size() {
      return entries.size;
    },
    get(id: string) {
      return entries.get(id)?.value;
    },
    lookup,
    unpreparedSuccessors(
      references: readonly ConversationKnowledgeReference[],
      index: number,
      published: ReadonlyMap<string, PreparedRootKnowledgeContribution>,
    ) {
      const current = references[index]!;
      const next: ConversationKnowledgeReference[] = [];
      for (let offset = 1; offset < MAX_SESSION_MODEL_CONTEXT_BATCH_RANGES; offset++) {
        const reference = references[index + offset];
        if (
          !reference ||
          reference.source.sessionId !== current.source.sessionId ||
          reference.source.sessionKey !== current.source.sessionKey ||
          reference.through.generation !== current.through.generation ||
          lookup(reference, published)
        ) {
          break;
        }
        next.push(reference);
      }
      return next;
    },
    assertRange(value: PreparedRootKnowledgeContribution) {
      if (
        !sameConversationKnowledgeCheckpointRange(value.packet, {
          through: value.reference.readRange?.through ?? value.reference.through,
          from: value.reference.readRange?.admission ?? value.reference.privateAudience?.admission,
        })
      ) {
        evict(value.contributionId);
        throw new Error("Checkpoint prepared source bytes changed");
      }
    },
    values() {
      return Array.from(entries.values(), ({ value }) => value);
    },
    projection() {
      // Carry one detached immutable projection until this owner changes its tail.
      // Current native audience/range custody is still checked by every consumer.
      return (projection ??= freezeJsonSnapshot(
        [...entries.values()]
          .toSorted((left, right) => left.order - right.order)
          .map(({ value }) => ({
            reference: value.reference,
            packet: value.packet,
          })),
      ));
    },
    reconcile(
      references: readonly ConversationKnowledgeReference[],
      coverage?: PreparedConversationKnowledgeCheckpointCoverage,
    ) {
      const byId = new Map(
        references.map((ref) => [conversationKnowledgeContributionId(ref), ref]),
      );
      const order = new Map(
        references.map((ref, index) => [conversationKnowledgeContributionId(ref), index]),
      );
      for (const [id, entry] of entries) {
        const reference = byId.get(id);
        if (!reference || coverage?.has(id) || JSON.stringify(reference) !== entry.referenceKey) {
          evict(id);
        } else if (entry.order !== order.get(id)) {
          entry.order = order.get(id)!;
          projection = undefined;
          revision++;
        }
      }
    },
    put(value: PreparedRootKnowledgeContribution, order: number, maxBytes: number) {
      const id = conversationKnowledgeContributionId(value.reference);
      const existing = entries.get(id);
      if (existing) {
        return existing.value;
      }
      // The published frame may retain these bytes even when the recipient cache is full.
      // Strip any extra custody from the original read before either owner keeps the packet.
      const { contributionId, complete, text, reference, packet } = value;
      const retained = freezeJsonSnapshot(
        structuredClone({ contributionId, complete, text, reference, packet }),
      );
      const referenceKey = JSON.stringify(value.reference);
      const size =
        Buffer.byteLength(value.text, "utf8") +
        Buffer.byteLength(JSON.stringify(value.packet), "utf8") +
        Buffer.byteLength(referenceKey, "utf8");
      if (bytes + size <= maxBytes) {
        entries.set(id, { referenceKey, value: retained, bytes: size, order });
        bytes += size;
        projection = undefined;
        revision++;
      }
      return retained;
    },
    evict,
    clear() {
      entries.clear();
      bytes = 0;
      projection = undefined;
    },
  };
}
