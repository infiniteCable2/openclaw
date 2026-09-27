import type { RealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import type { createMeetingBargeInGate } from "./realtime-output-gate.js";

/** A confirmed caller turn ends both queued output and any in-flight synthesis. */
export function createMeetingSpeechCancellation(params: {
  harness: () => RealtimeVoiceSessionHarness;
  activeTtsAborts: Set<AbortController>;
  activeTtsReaders: Set<ReadableStreamDefaultReader<Uint8Array>>;
  bargeInGate: ReturnType<typeof createMeetingBargeInGate>;
  onPlaybackWindowCancelled: () => void;
}) {
  const cancelActiveSpeech = () => {
    for (const controller of params.activeTtsAborts) {
      controller.abort(new Error("Meeting caller started speaking"));
    }
    for (const reader of params.activeTtsReaders) {
      void reader.cancel().catch(() => undefined);
    }
    void params.bargeInGate.clearOutput().catch(() => undefined);
  };

  const finishCancelledOutput = () => {
    const harness = params.harness();
    harness.flushOutput(cancelActiveSpeech);
    harness.finishOutputAudio("cancelled");
    harness.endTurn("cancelled");
  };

  const cancelActivePlayback = () => {
    if (!params.harness().isOutputPlaybackWindowActive()) {
      return;
    }
    params.onPlaybackWindowCancelled();
    finishCancelledOutput();
  };

  const cancelForConfirmedTurn = () => {
    if (
      params.activeTtsAborts.size === 0 &&
      params.activeTtsReaders.size === 0 &&
      !params.harness().isOutputPlaybackWindowActive()
    ) {
      return false;
    }
    finishCancelledOutput();
    return true;
  };

  return { cancelActiveSpeech, cancelActivePlayback, cancelForConfirmedTurn };
}
