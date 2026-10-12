import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import { readToolStringParam, textResult } from "../../agents/tools/common.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { parseSpeechExpression } from "../../tts/expression.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { MessageActionInput, MessageActionResult } from "./message-action-contracts.js";
import { assertMessageDeliveryCurrent } from "./message-action-execution.js";
import { buildMessagePayload } from "./message-action-send.js";

/** An explicit destination always retains the native external routing path. */
export function isImplicitCurrentSourceSend(
  action: string,
  params: Record<string, unknown>,
): boolean {
  return (
    action === "send" &&
    !["channel", "target", "to", "channelId", "accountId", "threadId", "replyTo"].some(
      (key) => normalizeOptionalStringifiedId(params[key]) !== undefined,
    ) &&
    !Array.isArray(params.targets)
  );
}

export async function deliverToCurrentSourceReplyTarget(
  input: MessageActionInput,
): Promise<MessageActionResult> {
  const target = input.currentSourceReplyTarget;
  if (!target || target.runId !== input.runId || target.sessionId !== input.sessionId) {
    throw new Error("Current-source reply target does not belong to this run");
  }
  const assertCurrent = () => {
    assertMessageDeliveryCurrent(input);
    target.assertCurrent();
  };
  assertCurrent();
  const params = { ...input.params };
  if (
    target.speechExpressionRequired &&
    Object.keys(params).some(
      (key) =>
        !["message", "voiceText", "voiceExpression", "idempotencyKey", "dryRun"].includes(key),
    )
  ) {
    throw new Error(
      "Current-source speech accepts only plain message and structured speech fields",
    );
  }
  const parts = await buildMessagePayload({ actionParams: params, input, agentId: input.agentId });
  assertCurrent();
  const speech = getReplyPayloadMetadata(parts.payload)?.tts;
  if (target.speechExpressionRequired) {
    if (!speech?.expression || speech.text === undefined || speech.text !== parts.payload.text) {
      throw new Error(
        "Current-source speech requires an expression and exact plain message/voiceText",
      );
    }
    parseSpeechExpression(speech.expression, speech.text);
    if (speech.text.length > 320) {
      throw new Error("Current-source speech utterances must be at most 320 characters");
    }
  }
  const dryRun = input.dryRun === true || params.dryRun === true;
  const final = input.sourceReplyFinal !== false;
  const phase = input.currentSourceReplyPhase ?? "final_answer";
  if (phase === "commentary" && final) {
    throw new Error("Commentary cannot complete the current-source reply");
  }
  const idempotencyKey = readToolStringParam(params, "idempotencyKey");
  if (!dryRun) {
    assertCurrent();
    await target.deliver(parts.payload, {
      final,
      phase,
      toolCallId: input.sourceReplyToolCallId,
      idempotencyKey,
    });
    assertCurrent();
  }
  const payload = {
    status: "ok",
    deliveryStatus: dryRun ? "dry_run" : "sent",
    sourceReplySink: "current-source",
    sourceReplyRoute: "current-source",
    sourceReply: parts.payload,
    dryRun,
  };
  return {
    kind: "send",
    channel: INTERNAL_MESSAGE_CHANNEL,
    action: "send",
    to: "current-run",
    handledBy: "current-source",
    payload,
    dryRun,
    toolResult: textResult(
      dryRun
        ? "Prepared current-source reply."
        : "Handed reply to the current source delivery owner.",
      payload,
    ),
  };
}
