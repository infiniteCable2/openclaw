import { randomUUID } from "node:crypto";
import type { ReplySpeechRunBinding } from "../../auto-reply/reply/reply-speech-presentation.js";
import type { RealtimeVoiceAgentControlResult } from "../agent-run-control-shared.js";
import {
  claimConversationInputExecution,
  consumeConversationInputAdmission,
  releaseConversationInputAdmission,
} from "../conversation-input-admission.js";
import type { ConversationReplyResult } from "../conversation-reply.js";
import { bindAdmittedSpeechInput, type AdmittedSpeechControl } from "./native-control.js";
import type { createSpeechOutput, SpeechUtterance } from "./output.js";
import {
  captureSpeechPlaybackObservation,
  type SpeechPlaybackSnapshot,
} from "./playback-observation.js";
import type { createSpeechInputMetadata } from "./session-input-identity.js";
import type { SpeechNativeInputParams, SpeechSessionStartParams } from "./types.js";
import type { createSpeechVideoInput } from "./video-input.js";

type NativeSpeechRun = {
  binding: ReplySpeechRunBinding;
  generation: number;
  inputId: string;
  unplayedResult?: boolean;
  utterance: SpeechUtterance;
  admissions: Set<Promise<void>>;
};

/** Media custody only. Native getReply owns ordering, steering, persistence and task lifetime. */
export function createNativeSpeechInput(params: {
  dispatch: NonNullable<SpeechSessionStartParams["nativeInput"]>;
  session: Pick<SpeechSessionStartParams, "sessionId" | "requesterSessionKey" | "config">;
  inputs: ReturnType<typeof createSpeechInputMetadata>;
  video: ReturnType<typeof createSpeechVideoInput>;
  output: Pick<
    ReturnType<typeof createSpeechOutput>,
    | "createSpeechUtterance"
    | "enqueueSpeechChunk"
    | "finalizeSpeechUtterance"
    | "enqueueSpeechResult"
    | "isCurrentSpeechUtterance"
  >;
  isStopped(): boolean;
  getGeneration(): number;
  startWaiting(): number;
  finishWaiting(turn: number): void;
  abortSpeechUtterance(utterance: SpeechUtterance): void;
  waitForInput(run: NativeSpeechRun, signal?: AbortSignal): void | Promise<void>;
  recordUnplayed(utterance: SpeechUtterance, text: string): void;
  onFailure(error: unknown): void;
}) {
  let active: NativeSpeechRun | undefined;
  let lastOutput: NativeSpeechRun | undefined;
  const captureRun = () => active;
  const capturePlayback = (onsetAtMs?: number, playbackActive = false) => {
    const source = active ?? lastOutput;
    return source && !params.isStopped()
      ? captureSpeechPlaybackObservation({
          source,
          runActive: source === active,
          playbackActive,
          onsetAtMs,
        })
      : undefined;
  };
  const submit = async (input: {
    text: string;
    metadata?: ReturnType<typeof params.inputs.capture>;
    onsetRun?: NativeSpeechRun;
    onsetPlayback?: SpeechPlaybackSnapshot;
    hasOnset: boolean;
    onAccepted?: () => void;
    inputId?: string;
    assertCurrent?: () => void;
    signal?: AbortSignal;
    admittedControl?: AdmittedSpeechControl;
    onQueueAccepted?: () => void;
    onInputDisposition?: SpeechNativeInputParams["onInputDisposition"];
  }): Promise<ConversationReplyResult> => {
    input.signal?.throwIfAborted();
    input.assertCurrent?.();
    if (params.isStopped()) {
      throw new Error("Speech input connection is closed");
    }
    const generation = params.getGeneration();
    const waitingTurn = params.startWaiting();
    const captured = input.hasOnset ? input.onsetRun : active;
    const metadata = input.metadata ? params.inputs.read(input.metadata) : undefined;
    const inputId = input.inputId ?? metadata?.input.inputId ?? randomUUID();
    const playback = input.hasOnset ? input.onsetPlayback : capturePlayback();
    let run: NativeSpeechRun | undefined;
    let adopted = false;
    let finalized = false;
    let settleAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      settleAdmission = resolve;
    });
    captured?.admissions.add(admission);
    const releaseAdmission = () => {
      settleAdmission();
      captured?.admissions.delete(admission);
    };
    const finishWaiting = () => params.finishWaiting(waitingTurn);
    try {
      const visual = await params.video.prepare(metadata?.snapshot, input.signal);
      input.signal?.throwIfAborted();
      input.assertCurrent?.();
      if (params.isStopped()) {
        throw new Error("Speech input connection closed during preparation");
      }
      const nativeInput: SpeechNativeInputParams = {
        sessionId: params.session.sessionId,
        requesterSessionKey: params.session.requesterSessionKey,
        inputId,
        ...(playback
          ? {
              playbackObservation: {
                version: 1,
                inputId,
                outputGeneration: generation,
                ...playback,
              },
            }
          : {}),
        purpose: captured ? "steering" : "user",
        // A delayed decoder result cannot steer whichever replacement run is active now.
        queueMode:
          input.admittedControl?.mode === "followup"
            ? "followup"
            : captured && captured === active
              ? "steer"
              : "followup",
        args: {
          question: input.text,
          responseStyle: "Brief, natural spoken answer for a live conversation.",
          ...(visual.context ? { context: visual.context } : {}),
        },
        images: visual.images,
        ...(params.video.source ? { toolBindings: { video_inspect: params.video.source } } : {}),
        transcript: [], // Native history is authoritative; do not append a copied audio log.
        onQueueAccepted: () => {
          input.onAccepted?.();
          input.onQueueAccepted?.();
        },
        bufferReply: params.session.config.responseStreaming !== "sentence",
        onNativeRunBound(binding) {
          const utterance = params.output.createSpeechUtterance(waitingTurn);
          utterance.generation = generation;
          run = { binding, generation, inputId, utterance, admissions: new Set() };
          active = run;
          lastOutput = run;
          releaseAdmission();
        },
        onInputDisposition(disposition) {
          input.onAccepted?.();
          input.onInputDisposition?.(disposition);
          try {
            if (
              disposition.mode === "steer" &&
              disposition.committed &&
              captured &&
              active === captured &&
              captured.binding.runId === disposition.runId &&
              !params.isStopped()
            ) {
              captured.binding.assertCurrent();
              captured.binding.abortSignal.throwIfAborted();
              // Only newly generated text may use the adopted generation. Never replay old PCM.
              const utterance = params.output.createSpeechUtterance(waitingTurn);
              utterance.generation = generation;
              captured.generation = generation;
              captured.utterance = utterance;
              adopted = true;
            }
          } finally {
            releaseAdmission();
          }
        },
        waitForPendingInput: (signal) => (run ? params.waitForInput(run, signal) : undefined),
        async onSpeakableText(event) {
          if (!run || params.isStopped()) {
            return;
          }
          const utterance = run.utterance;
          if (event.type === "chunk") {
            params.output.enqueueSpeechChunk(
              event.text,
              utterance,
              event.speech,
              // Queued synthesis acquires its own native readiness lease; a completed
              // model turn's preparation cannot authorize a later TTS job.
              undefined,
              event.expectedSpeechSelection,
            );
          } else if (event.type === "done") {
            // Finalize after this run's already admitted additions have resolved.
            // Their native dispatch can finish just after the model's terminal event.
            while (run.admissions.size > 0) {
              await Promise.all(run.admissions);
            }
            if (run.generation === params.getGeneration() && !params.isStopped()) {
              params.output.finalizeSpeechUtterance(run.utterance, event.text);
              finalized = true;
            }
          } else {
            // Output abort is not permission to cancel or repeat native user work.
            // The shared cancellation owner also clears queued audio and waiting state.
            // A late abort from an older run must not cancel its successor's output.
            if (lastOutput === run) {
              params.abortSpeechUtterance(utterance);
            } else {
              utterance.finalized = true;
            }
            finalized = true;
          }
        },
      };
      const result = await params.dispatch(
        bindAdmittedSpeechInput(nativeInput, input.admittedControl),
      );
      if (run) {
        while (run.admissions.size > 0) {
          await Promise.all(run.admissions);
        }
      }
      if (result.kind === "steered") {
        return result;
      }
      if (!run) {
        // Native shortcuts may answer without opening a model run. This is delivery of
        // that accepted input's result, not a manufactured backend or steering owner.
        if (!params.isStopped() && generation === params.getGeneration() && result.reply.text) {
          const utterance = params.output.createSpeechUtterance(waitingTurn);
          utterance.generation = generation;
          params.output.finalizeSpeechUtterance(utterance, result.reply.text);
        }
        return result;
      }
      if (run.generation !== params.getGeneration() || params.isStopped()) {
        run.unplayedResult = Boolean(result.reply.text.trim()) && run.utterance.chunks.length === 0;
        params.recordUnplayed(run.utterance, result.reply.text);
        return result;
      }
      if (finalized) {
        return result;
      }
      if (run.utterance.chunks.length === 0) {
        if (result.reply.utterances?.length) {
          params.output.enqueueSpeechResult(
            {
              ...result.reply,
              utterances: result.reply.utterances.map((part) => ({
                ...part,
                localServiceAdmission: undefined,
              })),
            },
            run.utterance,
          );
        } else {
          params.output.finalizeSpeechUtterance(run.utterance, result.reply.text);
        }
      } else {
        params.output.finalizeSpeechUtterance(run.utterance, result.reply.text);
      }
      return result;
    } finally {
      input.onAccepted?.();
      releaseAdmission();
      metadata?.snapshot?.release();
      if (active === run) {
        active = undefined;
      }
      // Nonempty output keeps its own waiting turn until the shared playout queue drains.
      if (
        !adopted &&
        (!run ||
          run.utterance.chunks.length === 0 ||
          !params.output.isCurrentSpeechUtterance(run.utterance))
      ) {
        finishWaiting();
      }
    }
  };
  return {
    captureRun,
    capturePlayback,
    submit,
    async control(
      this: void,
      input: AdmittedSpeechControl,
    ): Promise<RealtimeVoiceAgentControlResult> {
      const captured = active;
      const sessionKey = params.session.requesterSessionKey;
      try {
        input.signal?.throwIfAborted();
        input.assertInputCurrent?.();
        if (
          !sessionKey ||
          input.scope.conversationId !== params.session.sessionId ||
          input.scope.agentId !== params.session.config.agentId
        ) {
          throw new Error("Speech control does not match its original conversation");
        }
        if (params.isStopped()) {
          throw new Error("Speech input connection is closed");
        }
        if (input.mode === "status" || input.mode === "cancel" || !captured) {
          const accepted = consumeConversationInputAdmission(input.admission, input.scope);
          try {
            claimConversationInputExecution(accepted);
            if (accepted.source.sessionKey !== sessionKey) {
              throw new Error("Speech control input belongs to a different native session");
            }
            const { controlRealtimeVoiceAgentRun } = await import("../agent-run-control.js");
            input.signal?.throwIfAborted();
            input.assertInputCurrent?.();
            accepted.assertCurrent();
            return await controlRealtimeVoiceAgentRun({
              sessionKey,
              runTarget: captured
                ? {
                    runId: captured.binding.runId,
                    signal: captured.binding.abortSignal,
                    isCurrent(sessionId) {
                      input.signal?.throwIfAborted();
                      input.assertInputCurrent?.();
                      accepted.assertCurrent();
                      if (params.isStopped() || active !== captured) {
                        return false;
                      }
                      captured.binding.assertCurrent();
                      return sessionId === undefined || sessionId === captured.binding.sessionId;
                    },
                  }
                : null,
              text: input.text,
              mode: input.mode,
            });
          } finally {
            accepted.release?.();
          }
        }
        // Admission ACK is distinct from task completion. The same submit owner
        // keeps the opaque input, queued reply and audio alive until settlement.
        let acknowledge!: (result: RealtimeVoiceAgentControlResult) => void;
        const acknowledged = new Promise<RealtimeVoiceAgentControlResult>((resolve) => {
          acknowledge = resolve;
        });
        const result: RealtimeVoiceAgentControlResult = {
          ok: true,
          mode: input.mode,
          sessionKey,
          sessionId: captured.binding.sessionId,
          active: true,
          queued: true,
          message:
            input.mode === "followup"
              ? "Queued that follow-up for the active OpenClaw run."
              : "Got it. I steered the active run.",
          speak: true,
          show: true,
          suppress: false,
        };
        const completion = submit({
          text: input.text,
          inputId: input.scope.inputId,
          hasOnset: true,
          onsetRun: captured,
          admittedControl: input,
          assertCurrent: input.assertInputCurrent,
          signal: input.signal,
          onQueueAccepted: () => acknowledge(result),
          onInputDisposition: (disposition) => {
            if (disposition.committed) {
              acknowledge(result);
            }
          },
        }).then(() => result);
        void completion.catch((error: unknown) => params.onFailure(error));
        return await Promise.race([acknowledged, completion]);
      } finally {
        // No-op after transfer; otherwise releases a refusal before dispatch.
        releaseConversationInputAdmission(input.admission);
      }
    },
    enqueue(input: Parameters<typeof submit>[0]) {
      // Accepted native work outlives media close; this observer never aborts or retries it.
      void submit(input).catch((error: unknown) => params.onFailure(error));
    },
  };
}
