import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { ConversationKnowledgeReference } from "./conversation-knowledge.js";

/** A stable original occurrence; renewed physical read anchors do not change its identity. */
export function conversationKnowledgeContributionId(
  receipt: ConversationKnowledgeReference,
): string {
  return sha256Hex(
    JSON.stringify([
      receipt.origin,
      receipt.through.generation,
      receipt.through.rawSeq,
      receipt.through.entryId,
    ]),
  );
}

/** Durable packet identity does not require rendering or loading its conversation text. */
export function conversationKnowledgePacketId(contributionId: string, offset: number): string {
  return sha256Hex(JSON.stringify([contributionId, offset]));
}
