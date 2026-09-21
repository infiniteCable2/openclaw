import type { RealtimeTranscriptionSessionCallbacks } from "../realtime-transcription/provider-types.js";
import type { MeetingWaitingAudioPlayback } from "./waiting-audio.js";

/** Correlate transcription/consult feedback without creating a second playback queue. */
export function createMeetingAgentWaitingAudio(params: {
  playback: MeetingWaitingAudioPlayback;
  isStopped: () => boolean;
  canStart: () => boolean;
  onError: (error: unknown) => void;
}) {
  const pending = new Set<string>();
  let utteranceId: string | undefined;
  let scheduled = false;
  let generation = 0;

  const stop = (owner?: number): Promise<void> => {
    if (owner !== undefined && owner !== generation) {
      return Promise.resolve();
    }
    generation += 1;
    utteranceId = undefined;
    scheduled = false;
    if (params.isStopped()) {
      pending.clear();
    }
    return params.playback.stop();
  };
  const stopInBackground = (owner?: number) => {
    void stop(owner).catch(params.onError);
  };
  const schedule = () => {
    if (scheduled || params.isStopped()) {
      return;
    }
    scheduled = true;
    generation += 1;
    params.playback.schedule();
  };
  const retryConfirmed = () => {
    if (utteranceId !== undefined && pending.has(utteranceId) && params.canStart()) {
      schedule();
    }
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
    onProcessing,
    onOutputIdle: retryConfirmed,
    onSpeechStart() {
      // New speech invalidates confirmations still queued by older audio.
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
