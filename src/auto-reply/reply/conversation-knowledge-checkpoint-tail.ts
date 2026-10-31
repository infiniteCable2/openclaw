import type { PreparedConversationKnowledgeCheckpointCoverage } from "../../config/sessions/conversation-knowledge-checkpoint.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import type { PreparedRootKnowledgeContribution } from "./conversation-knowledge-checkpoint-range.js";

/** Disposable text cache only; its contents never grant disclosure or replace native receipts. */
export function createConversationKnowledgeCheckpointTail() {
  const entries = new Map<
    string,
    { referenceKey: string; value: PreparedRootKnowledgeContribution; bytes: number; order: number }
  >();
  let bytes = 0;
  let revision = 0;
  const evict = (id: string) => {
    const entry = entries.get(id);
    if (!entry) {
      return false;
    }
    bytes -= entry.bytes;
    entries.delete(id);
    revision++;
    return true;
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
    values() {
      return Array.from(entries.values(), ({ value }) => value);
    },
    projection() {
      return [...entries.values()]
        .toSorted((left, right) => left.order - right.order)
        .map(({ value }) => ({
          reference: structuredClone(value.reference),
          packet: structuredClone(value.packet),
        }));
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
          revision++;
        }
      }
    },
    put(value: PreparedRootKnowledgeContribution, order: number, maxBytes: number) {
      const referenceKey = JSON.stringify(value.reference);
      const size =
        Buffer.byteLength(value.text, "utf8") +
        Buffer.byteLength(JSON.stringify(value.packet), "utf8") +
        Buffer.byteLength(referenceKey, "utf8");
      const id = conversationKnowledgeContributionId(value.reference);
      if (!entries.has(id) && bytes + size <= maxBytes) {
        entries.set(id, { referenceKey, value, bytes: size, order });
        bytes += size;
        revision++;
      }
    },
    evict,
    clear() {
      entries.clear();
      bytes = 0;
    },
  };
}
