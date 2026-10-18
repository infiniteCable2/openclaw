import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import type { QueuedFollowupReplyDelivery } from "../auto-reply/reply/queue/types.js";
import type { ReplyOperationRunState } from "../auto-reply/reply/reply-operation-run-state.js";
import type { ReplySpeechRunBinding } from "../auto-reply/reply/reply-speech-presentation.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { isSilentReplyText } from "../auto-reply/tokens.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CreateUserTurnTranscriptRecorderParams } from "../sessions/user-turn-transcript.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { RealtimeVoiceAgentConsultResult } from "./agent-consult-runtime.js";
import { collectRealtimeVoiceAgentConsultVisibleText } from "./agent-consult-tool.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  prepareConversationReplyContext,
  type ConsumedConversationInput,
} from "./conversation-input-admission.js";
import type {
  ConversationInputAdmissionV1,
  ConversationInputScopeV1,
} from "./conversation-input.types.js";
import { createReplySpeechPresentation } from "./reply-speech-presentation.js";

const loadReply = createLazyRuntimeModule(async () => {
  const [reply, state] = await Promise.all([
    import("../auto-reply/reply/get-reply.js"),
    import("../auto-reply/reply/reply-operation-run-state.js"),
  ]);
  return {
    getReplyFromConfig: reply.getReplyFromConfig,
    state,
  };
});

type SpeechPresentationParams = Parameters<typeof createReplySpeechPresentation>[0];
export type PreparedConversationSpeech = {
  presentation: Omit<SpeechPresentationParams, "onResult">;
  release(): void | Promise<void>;
};

/** Host-only input adapter. The native reply owner still selects sessions, tools and the queue. */
export type ConversationReplyParams = {
  cfg: OpenClawConfig;
  admission: ConversationInputAdmissionV1;
  scope: ConversationInputScopeV1;
  text: string;
  images?: GetReplyOptions["images"];
  /** Original host-owned live bindings; not an agent-selected tool grant. */
  toolBindings?: RunEmbeddedAgentParams["toolBindings"];
  thinkingLevelOverride?: GetReplyOptions["thinkingLevelOverride"];
  /** Explicit task cancellation only. Closing the audio transport is not task cancellation. */
  workSignal?: AbortSignal;
  /** This can only narrow the native channel/agent tool policy. */
  toolsAllow?: string[];
  queueMode?: "steer" | "followup";
  onRunStarted?: GetReplyOptions["onAgentRunStart"];
  onOriginalInputCommitted?: CreateUserTurnTranscriptRecorderParams["onOriginalInputCommitted"];
  /** Host-owned narrowing only; it cannot replace the original input authority. */
  assertWorkCurrent?: SessionSourceAssertion;
  /** Supplemental source data only; native context assembly keeps it untrusted. */
  runtimeContext?: MsgContext["ChannelStructuredContext"];
  onQueueAccepted?: () => void;
  onInputDisposition?: (disposition: {
    mode: "owned" | "steer" | "followup";
    committed: boolean;
    /** Native committed injection target, never a caller-selected run. */
    runId?: string;
  }) => void;
  onNativeRunBound?: (binding: ReplySpeechRunBinding) => void;
  speech: Omit<SpeechPresentationParams, "onResult">;
  /** Called only after original input consumption and native context projection. */
  prepareSpeech?: () => Promise<PreparedConversationSpeech>;
};

function visibleResult(payloads: ReplyPayload | ReplyPayload[] | undefined) {
  const visible = (
    payloads === undefined ? [] : Array.isArray(payloads) ? payloads : [payloads]
  ).filter((payload) => !isSilentReplyText(payload.text));
  return {
    text: collectRealtimeVoiceAgentConsultVisibleText(visible) ?? "",
  } satisfies RealtimeVoiceAgentConsultResult;
}

export type ConversationReplyResult =
  | { kind: "reply"; reply: RealtimeVoiceAgentConsultResult }
  /** Native committed injection; the existing running turn retains its output. */
  | { kind: "steered" };

/**
 * Keep completion attached to the claimed input through native queueing. A queued dispatch
 * returning is not a completed voice answer.
 */
async function executeConversationReply(
  params: ConversationReplyParams,
  input: ConsumedConversationInput,
  ctxPayload: MsgContext,
  speech: ConversationReplyParams["speech"],
  preparationFailed: boolean,
): Promise<ConversationReplyResult> {
  let presentationResult: RealtimeVoiceAgentConsultResult | undefined;
  let outputFailed = preparationFailed;
  let deferred = false;
  let dispatchReturned = false;
  let settledWithoutReceipt = false;
  let completed = false;
  let nativeRunBound = false;
  let lastDisposition: string | undefined;
  const runState: ReplyOperationRunState = {};
  const assertWorkCurrent = composeSessionSourceAssertion([
    input.assertCurrent,
    params.assertWorkCurrent,
  ]);
  let resolveCompletion!: (result: ConversationReplyResult) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<ConversationReplyResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A native abandonment callback can run while preprocessing is still awaited.
  // Attach rejection custody immediately, while retaining the original result below.
  void completion.catch(() => {});
  const succeed = (payloads?: ReplyPayload | ReplyPayload[]) => {
    if (completed) return;
    completed = true;
    // Output failure must not replay successfully executed tools. The output owner already
    // recorded the failure; no generated text is returned for accidental second playback.
    resolveCompletion({
      kind: "reply",
      reply: outputFailed ? { text: "" } : (presentationResult ?? visibleResult(payloads)),
    });
  };
  const fail = (error: unknown) => {
    if (completed) return;
    completed = true;
    rejectCompletion(error);
  };
  const settleWithoutReply = () => {
    if (completed || !dispatchReturned || !settledWithoutReceipt) return;
    if (
      runState.admission?.status === "accepted" &&
      runState.admission.mode === "steer" &&
      runState.messageInjectionAborted !== true
    ) {
      completed = true;
      resolveCompletion({ kind: "steered" });
    } else {
      fail(new Error("Native conversation input settled without a completion receipt"));
    }
  };
  const queuedDelivery: QueuedFollowupReplyDelivery = Object.assign(
    async (batch: Parameters<QueuedFollowupReplyDelivery>[0]) => {
      if (batch.completion.kind === "progress") return;
      if (batch.completion.kind === "completed") {
        succeed(batch.payloads);
      } else {
        fail(new Error("Native queued conversation work did not complete"));
      }
    },
    { ownsCompletion: () => true },
  );
  const observe = (callback: () => void) => {
    try {
      callback();
    } catch (error) {
      try {
        speech.onError(error);
      } catch {
        // Presentation observers cannot release task custody or authorize retries.
      }
    }
  };
  const notifyDisposition = (
    mode: "owned" | "steer" | "followup",
    committed: boolean,
    runId?: string,
  ) => {
    const key = `${mode}:${committed}:${runId ?? ""}`;
    if (lastDisposition === key) return;
    lastDisposition = key;
    observe(() => params.onInputDisposition?.({ mode, committed, ...(runId ? { runId } : {}) }));
  };
  const speechPresentation = createReplySpeechPresentation({
    ...speech,
    onRunBound(binding) {
      nativeRunBound = true;
      notifyDisposition("owned", true);
      observe(() => {
        speech.onRunBound?.(binding);
        params.onNativeRunBound?.(binding);
      });
    },
    onResult(result) {
      presentationResult = result;
    },
    onError(error) {
      outputFailed = true;
      try {
        speech.onError(error);
      } catch {
        // Diagnostic observers cannot undo or authorize replay of accepted work.
      }
    },
  });
  const options: InternalGetReplyOptions = {
    assertSourceCurrent: assertWorkCurrent,
    assertConversationTarget(target) {
      assertWorkCurrent();
      if (target.agentId !== input.scope.agentId || target.sessionKey !== input.source.sessionKey) {
        throw new Error("Native conversation input target changed after original admission");
      }
    },
    operatorAuthority: input.operatorAuthority,
    speechPresentation,
    images: params.images,
    thinkingLevelOverride: params.thinkingLevelOverride,
    toolsAllow: params.toolsAllow,
    abortSignal: params.workSignal,
    suppressTyping: true,
    onAgentRunStart: params.onRunStarted,
    onOriginalInputCommitted: params.onOriginalInputCommitted,
    queueModeOverride: params.queueMode,
    onQueuedFollowupReplyBatch: queuedDelivery,
    turnAdoptionLifecycle: {
      admission: "exclusive",
      abortSignal: params.workSignal,
      onAdopted: assertWorkCurrent,
      onDeferred() {
        deferred = true;
        observe(() => params.onQueueAccepted?.());
      },
      onAbandoned() {
        fail(new Error("Native conversation input was abandoned before execution"));
      },
      onSettled() {
        // Native same-turn steering consumes the parked input without another reply
        // batch. Interpret its actual invocation receipt only after dispatch returns.
        settledWithoutReceipt = true;
        settleWithoutReply();
      },
    },
  };
  try {
    const { getReplyFromConfig, state } = await loadReply();
    options[state.REPLY_OPERATION_RUN_STATE] = runState;
    assertWorkCurrent();
    params.workSignal?.throwIfAborted();
    const result = await getReplyFromConfig(ctxPayload, options, params.cfg);
    dispatchReturned = true;
    const admission = runState.admission;
    if (admission?.status === "accepted" && !(admission.mode === "followup" && nativeRunBound)) {
      const committed = runState.messageInjectionAborted !== true;
      notifyDisposition(
        admission.mode,
        committed,
        admission.mode === "steer" && committed ? runState.steeredRunId : undefined,
      );
    } else if (admission?.status === "owned" || (!deferred && !admission)) {
      notifyDisposition("owned", true);
    }
    if (!deferred) succeed(result);
    else settleWithoutReply();
  } catch (error) {
    fail(error);
  }
  return await completion;
}

export async function replyToConversationInput(
  params: ConversationReplyParams,
): Promise<ConversationReplyResult> {
  const input = consumeConversationInputAdmission(params.admission, params.scope);
  let prepared: PreparedConversationSpeech | undefined;
  let speech = params.speech;
  let preparationFailed = false;
  try {
    claimConversationInputExecution(input);
    params.workSignal?.throwIfAborted();
    const context = await prepareConversationReplyContext(input, { text: params.text });
    if (params.runtimeContext) {
      context.ChannelStructuredContext = [
        ...(context.ChannelStructuredContext ?? []),
        ...structuredClone(params.runtimeContext),
      ];
    }
    if (params.toolBindings) context.GatewayRunToolBindings = params.toolBindings;
    if (params.prepareSpeech) {
      try {
        prepared = await params.prepareSpeech();
        input.assertCurrent();
        params.workSignal?.throwIfAborted();
        speech = prepared.presentation;
      } catch (error) {
        input.assertCurrent();
        params.workSignal?.throwIfAborted();
        preparationFailed = true;
        try {
          params.speech.onError(error);
        } catch {
          // Diagnostic observers do not own accepted work or permission to replay it.
        }
        speech = {
          ...params.speech,
          onSpeakableText: undefined,
          speechExpressionContext: undefined,
          speakCommentary: false,
        };
      }
    }
    if (input.scope.purpose === "greeting") {
      if (preparationFailed) throw new Error("Greeting speech preparation is unavailable");
      const { prepareConversationGreeting } = await import("./conversation-greeting.js");
      input.assertCurrent();
      return {
        kind: "reply",
        reply: await prepareConversationGreeting({
          input,
          context,
          cfg: params.cfg,
          text: params.text,
          speech,
          signal: params.workSignal,
        }),
      };
    }
    return await executeConversationReply(params, input, context, speech, preparationFailed);
  } finally {
    try {
      try {
        await prepared?.release();
      } finally {
        input.release?.();
      }
    } catch (error) {
      if (input.scope.purpose === "greeting") throw error;
      try {
        params.speech.onError(error);
      } catch {
        // A release diagnostic must not turn completed user work into a retry.
      }
    }
  }
}
