import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Derived loss evidence issued only by the native final-archive deletion transaction. */
export type ConversationKnowledgeRetirement = {
  reason: "source-archive-pruned";
  generation: string;
  archiveSha256: string;
};

export function readConversationKnowledgeRetirement(
  value: unknown,
  effectiveGeneration: string,
): ConversationKnowledgeRetirement | undefined {
  const record = asOptionalRecord(value);
  return record?.reason === "source-archive-pruned" &&
    record.generation === effectiveGeneration &&
    typeof record.archiveSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(record.archiveSha256)
    ? {
        reason: record.reason,
        generation: effectiveGeneration,
        archiveSha256: record.archiveSha256,
      }
    : undefined;
}
