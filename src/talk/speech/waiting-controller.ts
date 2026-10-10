import type { RealtimeTranscriptionSessionCallbacks } from "../../realtime-transcription/provider-types.js";
import type { SpeechWaitingAudioPlayback } from "./waiting-audio.js";

/** Correlate transcription/consult feedback without creating a second playback queue. */
export function createSpeechWaitingController(params: {
  playback: SpeechWaitingAudioPlayback;
  isStopped: () => boolean;
  canStart: () => boolean;
  resumeDelayMs: number;
  onError: (error: unknown) => void;
}) {
  const pending = new Set<string>();
  let utteranceId: string | undefined;
  let scheduled = false;
  let generation = 0;
  let turnSerial = 0;
  let activeTurn: number | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelResume = () => {
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
    }
  };

  const stop = (owner?: number): Promise<void> => {
    if (owner !== undefined && owner !== generation) {
      return Promise.resolve();
    }
    generation += 1;
    utteranceId = undefined;
    scheduled = false;
    cancelResume();
    if (params.isStopped()) {
      pending.clear();
    }
    return params.playback.stop();
  };
  const stopInBackground = (owner?: number) => {
    void stop(owner).catch(params.onError);
  };
  const schedule = (delayMs?: number) => {
    if (scheduled || params.isStopped()) {
      return;
    }
    scheduled = true;
    generation += 1;
    params.playback.schedule(delayMs);
  };
  const retryConfirmed = () => {
    if (utteranceId !== undefined && pending.has(utteranceId) && params.canStart()) {
      schedule();
    }
  };
  const retryTurn = (turn: number) => {
    if (activeTurn !== turn || params.isStopped() || scheduled) {
      return;
    }
    if (params.canStart()) {
      schedule(0);
      return;
    }
    // The sink may still be playing the last TTS frame after its reader closes.
    resumeTimer = setTimeout(() => retryTurn(turn), 100);
  };
  const onProcessing: NonNullable<RealtimeTranscriptionSessionCallbacks["onProcessing"]> = (
    event,
  ) => {
    if (params.isStopped()) {
      return;
    }
    if (event.state === "started") {
      pending.add(event.utteranceId);
      return;
    }
    if (!pending.has(event.utteranceId)) {
      return;
    }
    if (event.state === "speech-confirmed") {
      if (utteranceId !== event.utteranceId) {
        generation += 1;
        utteranceId = event.utteranceId;
      }
      retryConfirmed();
      return;
    }
    pending.delete(event.utteranceId);
    if (event.state !== "transcribed" && utteranceId === event.utteranceId) {
      stopInBackground();
    }
  };

  return {
    get generation() {
      return generation;
    },
    schedule,
    stop,
    stopInBackground,
    onTurnStarted() {
      activeTurn = ++turnSerial;
      cancelResume();
      schedule();
      return activeTurn;
    },
    onTurnFinished(turn: number) {
      if (activeTurn !== turn) {
        return;
      }
      activeTurn = undefined;
      cancelResume();
      stopInBackground();
    },
    onProcessing,
    onOutputIdle(turn: number) {
      retryConfirmed();
      if (activeTurn !== turn || scheduled) {
        return;
      }
      cancelResume();
      resumeTimer = setTimeout(() => retryTurn(turn), params.resumeDelayMs);
    },
    onSpeechStart() {
      // New speech invalidates confirmations still queued by older audio.
      activeTurn = undefined;
      pending.clear();
      stopInBackground();
    },
    onTranscript(context: { utteranceId: string } | undefined, assistantEcho: boolean) {
      const continues = context?.utteranceId !== undefined && context.utteranceId === utteranceId;
      if ((assistantEcho && continues) || (!assistantEcho && !continues)) {
        stopInBackground();
      }
    },
  };
}
