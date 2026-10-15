import type { RealtimeVoiceAgentControlResult } from "../agent-run-control-shared.js";
import type { RealtimeVoiceSessionHarness } from "../realtime-session-harness.js";
import type { createSpeechCancellation } from "./cancellation.js";
import type { SpeechActiveConsult, SpeechSessionHandle } from "./types.js";

/** External session controls act on the exact current native owner, never a key-only lookup. */
export function createSpeechSessionControls(params: {
  harness: Pick<
    RealtimeVoiceSessionHarness,
    "isOutputPlaybackWindowActive" | "talk" | "flushOutput" | "finishOutputAudio"
  >;
  cancellation: Pick<
    ReturnType<typeof createSpeechCancellation>,
    "markInterruptedTranscript" | "cancelActiveSpeech"
  >;
  getConsult: () => SpeechActiveConsult | undefined;
  isStopped: () => boolean;
  getOutputGeneration: () => number;
  getOutputTurnId: () => string | undefined;
  hasOutput: () => boolean;
  invalidateOutput: () => void;
}): Pick<SpeechSessionHandle, "cancelOutput" | "steer"> {
  const { harness, cancellation } = params;
  return {
    cancelOutput: (request = {}) => {
      const outputTurnId = params.getOutputTurnId();
      const turnId =
        harness.isOutputPlaybackWindowActive() && outputTurnId
          ? outputTurnId
          : harness.talk.activeTurnId;
      if (request.turnId && request.turnId !== turnId) {
        return { status: "stale", turnId };
      }
      if (params.isStopped() || !params.hasOutput()) {
        return { status: "idle", turnId };
      }
      params.invalidateOutput();
      cancellation.markInterruptedTranscript();
      harness.flushOutput(cancellation.cancelActiveSpeech);
      harness.finishOutputAudio(request.reason ?? "cancelled");
      // Cancelling audio delivery does not cancel native work or its tool results.
      return { status: "applied", turnId };
    },
    steer: (request) => {
      const consult = params.getConsult();
      const control = consult?.control;
      if (params.isStopped() || !consult || !control || consult.followupOnly) {
        return Promise.reject(new Error("No active native speech consult accepts steering"));
      }
      const generation = params.getOutputGeneration();
      const admission = consult.admissions.then(
        async (): Promise<RealtimeVoiceAgentControlResult> => {
          request.signal?.throwIfAborted();
          request.assertCurrent?.();
          if (
            params.isStopped() ||
            params.getConsult() !== consult ||
            consult.control !== control
          ) {
            throw new Error("The native speech consult owner changed before steering");
          }
          const outcome = await control(request.text, undefined, request);
          if (outcome.queued) {
            consult.adoptedGeneration = generation;
            consult.unconfirmed ||= !outcome.ok;
            consult.followupOnly ||= !outcome.ok;
          }
          return outcome;
        },
      );
      consult.admissions = admission.then(
        () => undefined,
        () => {
          consult.unconfirmed = true;
          consult.followupOnly = true;
        },
      );
      return admission;
    },
  };
}
