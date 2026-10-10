import type { RealtimeTranscriptionSessionCallbacks } from "../../realtime-transcription/provider-types.js";
import type { SpeechAudioTransport, SpeechOutputGate } from "./transport.js";

export function createSpeechBargeInGate(params: {
  transport: SpeechAudioTransport;
  isStopped: () => boolean;
  hasActiveOutput: () => boolean;
  onFailure: (error: unknown) => void;
}) {
  let owner: string | undefined;
  let outputPaused = false;
  let waitingAudioHeldUntil = 0;
  // Matrix's native playout can retain PCM while paused. Give its bounded
  // queue time to drain after an unconfirmed candidate releases the gate.
  const POST_PAUSE_DRAIN_MS = 3_000;

  const setGate = (mode: SpeechOutputGate) => {
    if (!params.transport.setOutputGate || params.isStopped()) {
      return;
    }
    if (mode === "paused") {
      outputPaused = true;
    } else if (mode === "normal" && outputPaused) {
      outputPaused = false;
      waitingAudioHeldUntil = Date.now() + POST_PAUSE_DRAIN_MS;
    }
    void params.transport.setOutputGate(mode).catch(params.onFailure);
  };

  const release = (utteranceId?: string) => {
    if (!utteranceId || utteranceId !== owner) {
      return;
    }
    owner = undefined;
    setGate("normal");
  };

  const onSpeechActivity: NonNullable<RealtimeTranscriptionSessionCallbacks["onSpeechActivity"]> = (
    event,
  ) => {
    if (params.isStopped()) {
      return;
    }
    if (event.state === "candidate") {
      if (params.hasActiveOutput()) {
        owner = event.utteranceId;
        setGate("duck");
      }
    } else if (event.state === "sustained") {
      if (owner === event.utteranceId) {
        setGate("paused");
      }
    } else {
      release(event.utteranceId);
    }
  };

  const clearOutput = async () => {
    const currentOwner = owner;
    try {
      await params.transport.clearOutput();
    } finally {
      release(currentOwner);
      // Confirmed interruption clears the queued PCM, so no post-pause drain remains.
      outputPaused = false;
      waitingAudioHeldUntil = 0;
    }
  };

  const onProcessing: NonNullable<RealtimeTranscriptionSessionCallbacks["onProcessing"]> = (
    event,
  ) => {
    if (event.state === "empty" || event.state === "failed" || event.state === "cancelled") {
      release(event.utteranceId);
    }
  };

  return {
    onSpeechActivity,
    onProcessing,
    release,
    clearOutput,
    canResumeWaitingAudio: () => !outputPaused && Date.now() >= waitingAudioHeldUntil,
  };
}
