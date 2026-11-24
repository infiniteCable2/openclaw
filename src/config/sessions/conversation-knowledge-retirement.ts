import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export type ConversationKnowledgeRetirement =
  | { reason: "source-archive-pruned"; generation: string; archiveSha256: string }
  | {
      reason: "source-missing-confirmed" | "historical-private-range-unverified";
      generation: string;
      repairPlanSha256: string;
    };

const sha256 = /^[a-f0-9]{64}$/u;

export function readConversationKnowledgeRetirement(
  value: unknown,
  effectiveGeneration: string,
): ConversationKnowledgeRetirement | undefined {
  const record = asOptionalRecord(value);
  if (record?.generation !== effectiveGeneration) {
    return undefined;
  }
  if (
    record.reason === "source-archive-pruned" &&
    typeof record.archiveSha256 === "string" &&
    sha256.test(record.archiveSha256)
  ) {
    return {
      reason: record.reason,
      generation: effectiveGeneration,
      archiveSha256: record.archiveSha256,
    };
  }
  if (
    (record.reason === "source-missing-confirmed" ||
      record.reason === "historical-private-range-unverified") &&
    typeof record.repairPlanSha256 === "string" &&
    sha256.test(record.repairPlanSha256)
  ) {
    return {
      reason: record.reason,
      generation: effectiveGeneration,
      repairPlanSha256: record.repairPlanSha256,
    };
  }
  return undefined;
}
