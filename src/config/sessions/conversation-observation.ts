import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";

/** Original saved dialogue only; imported context and execution payloads are not new speech. */
export function readConversationObservationRole(
  message: unknown,
): "user" | "assistant" | undefined {
  const record = asOptionalRecord(message);
  const role = record?.role;
  const provenance = asOptionalRecord(record?.provenance);
  const metadata = asOptionalRecord(record?.["__openclaw"]);
  if (
    !record ||
    (role !== "user" && role !== "assistant") ||
    record.display === false ||
    record.excludeFromContext === true ||
    metadata?.lateMedia === true ||
    metadata?.beforeAgentRunBlocked !== undefined
  ) {
    return undefined;
  }
  if (provenance?.kind === "realtime_voice") {
    return provenance.sourceChannel === "talk" &&
      (role !== "assistant" || (record.api === "realtime" && record.stopReason === "stop")) &&
      !readSessionTranscriptRunId(record) &&
      (!Array.isArray(record.content) ||
        record.content.every((block) => asOptionalRecord(block)?.type === "text"))
      ? role
      : undefined;
  }
  if (provenance && provenance.kind !== "external_user") {
    return undefined;
  }
  const hasText =
    typeof record.content === "string"
      ? record.content.trim().length > 0
      : Array.isArray(record.content) &&
        record.content.some((value) => {
          const block = asOptionalRecord(value);
          return block?.type === "text" && typeof block.text === "string" && block.text.trim();
        });
  if (!hasText) {
    return undefined;
  }
  return role === "user" ||
    (readSessionTranscriptRunId(record) &&
      (record.stopReason === "stop" || record.stopReason === "toolUse"))
    ? role
    : undefined;
}

/** Only these native operational annotations leave every observed source byte unchanged. */
export function transcriptRewritePreservesConversationObservation(
  beforeJson: string,
  afterJson: string,
): boolean {
  const project = (json: string) => {
    const event = asOptionalRecord(JSON.parse(json));
    const message = asOptionalRecord(event?.message);
    if (
      event?.type !== "message" ||
      message?.role !== "user" ||
      readConversationObservationRole(message) !== "user"
    ) {
      return undefined;
    }
    const { __openclaw: _metadata, ...body } = message;
    const metadata = asOptionalRecord(message["__openclaw"]);
    if (message["__openclaw"] !== undefined && !metadata) {
      return undefined;
    }
    const {
      modelPromptProjection: _projection,
      steerTargetRunId: _steer,
      ...remaining
    } = metadata ?? {};
    return {
      ...event,
      message: { ...body, ...(Object.keys(remaining).length > 0 ? { __openclaw: remaining } : {}) },
    };
  };
  const before = project(beforeJson);
  const after = project(afterJson);
  return before !== undefined && after !== undefined && isDeepStrictEqual(before, after);
}
