import { Type, type TObject } from "typebox";
import { resolveActiveReplyOperationForSessionId } from "../../auto-reply/reply/reply-run-registry.js";
import type {
  CurrentSourceReplyTarget,
  MessageActionInput,
  MessageActionResult,
} from "../../infra/outbound/message-action-contracts.js";
import {
  getToolResult,
  type runMessageAction,
} from "../../infra/outbound/message-action-runner.js";
import type { MessageSpeechAdmission } from "../../tts/message-speech-admission.js";
import * as embeddedMessageDelivery from "../embedded-agent-message-delivery.js";
import { jsonResult } from "./common.js";
import type { createMessageToolDecisionRecorder } from "./message-tool-decision.js";
import { MessageToolSchema } from "./message-tool-schema.js";
import {
  addSourceReplyFinalControl,
  buildSourceReplyOnlyMessageSchema,
  enforceSourceReplyOnlyMessageAction,
  enforceSourceReplyOnlyTextDirectives,
} from "./message-tool-source-policy.js";
import { sanitizeMessageToolVisiblePayload } from "./message-tool-visible-content.js";

export function buildMessageToolSourceReplySchema(params: {
  sourceReplyOnly?: boolean;
  currentSourceReplyTarget?: CurrentSourceReplyTarget;
  messageSpeechAdmission?: MessageSpeechAdmission;
  discoverySchema?: TObject;
}): TObject {
  const baseSchema = params.sourceReplyOnly
    ? buildSourceReplyOnlyMessageSchema(
        params.currentSourceReplyTarget?.speechUtteranceOnly === true ||
          Boolean(params.messageSpeechAdmission),
        Boolean(params.currentSourceReplyTarget),
      )
    : (params.discoverySchema ?? MessageToolSchema);
  return addSourceReplyFinalControl(
    params.currentSourceReplyTarget
      ? Type.Object({
          ...baseSchema.properties,
          replyPhase: Type.Optional(
            Type.Union([Type.Literal("commentary"), Type.Literal("final_answer")], {
              description: "Current-source utterance lane; commentary requires final=false.",
            }),
          ),
        })
      : baseSchema,
  );
}

export function prepareMessageToolSourceReply(
  params: Parameters<typeof enforceSourceReplyOnlyMessageAction>[0] & {
    sourceReplyOnly?: boolean;
    agentSessionKey?: string;
  },
  decisions: Pick<ReturnType<typeof createMessageToolDecisionRecorder>, "runBoundary">,
) {
  if (params.sourceReplyOnly) {
    decisions.runBoundary(() => enforceSourceReplyOnlyMessageAction(params));
  }
  // `final` is host-owned completion control, never provider input or idempotency.
  const requestedSourceReplyFinal =
    typeof params.args.final === "boolean" ? params.args.final : undefined;
  delete params.args.final;
  const suppressedVisiblePayloadReason = sanitizeMessageToolVisiblePayload(
    params.args,
    params.agentSessionKey,
  );
  if (params.sourceReplyOnly) {
    decisions.runBoundary(() => enforceSourceReplyOnlyTextDirectives(params.args));
  }
  return { requestedSourceReplyFinal, suppressedVisiblePayloadReason };
}

/** Execute through the existing action owner; the caller retains run authority and routing. */
export async function deliverMessageToolCurrentSource(params: {
  input: MessageActionInput & {
    currentSourceReplyTarget: CurrentSourceReplyTarget;
    assertDirectAdapterHandoff: () => void;
  };
  runMessageAction: typeof runMessageAction;
  recordActionResult: (result: MessageActionResult) => void;
}) {
  const { input } = params;
  input.assertDirectAdapterHandoff();
  input.currentSourceReplyTarget.assertCurrent();
  const replyPhase = input.params.replyPhase;
  if (replyPhase !== undefined && replyPhase !== "commentary" && replyPhase !== "final_answer") {
    throw new Error("Invalid current-source reply phase");
  }
  delete input.params.replyPhase;
  const result = await params.runMessageAction({
    ...input,
    actionOrigin: "message-tool",
    currentSourceReplyPhase: replyPhase ?? "final_answer",
  });
  input.assertDirectAdapterHandoff();
  input.currentSourceReplyTarget.assertCurrent();
  params.recordActionResult(result);
  const fact = embeddedMessageDelivery.projectEmbeddedMessageDeliveryFact(result, true);
  if (fact?.status === "settled" && !result.dryRun && input.sourceReplyFinal !== false) {
    fact.sourceReplyDelivered = true;
    if (input.sessionId) {
      resolveActiveReplyOperationForSessionId(input.sessionId)?.markSourceReplyDelivered();
    }
  }
  return embeddedMessageDelivery.attachEmbeddedMessageDeliveryFact(
    getToolResult(result) ?? jsonResult(result.payload),
    fact,
  );
}
