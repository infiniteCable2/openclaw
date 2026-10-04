import type { RealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import type { RealtimeVoiceTranscriptEntry } from "../talk/session-log-runtime.js";
import type { createMeetingBargeInGate } from "./realtime-output-gate.js";

/** A confirmed caller turn ends both queued output and any in-flight synthesis. */
export function createMeetingSpeechCancellation(params: {
  harness: () => RealtimeVoiceSessionHarness;
  activeTtsAborts: Set<AbortController>;
  activeTtsReaders: Set<ReadableStreamDefaultReader<Uint8Array>>;
  bargeInGate: ReturnType<typeof createMeetingBargeInGate>;
}) {
  const captureInterruptedTranscript = () => {
    const harness = params.harness();
    const entries = harness.transcript.filter((entry) => entry.audioDelivery === "started");
    const lastAssistant = harness.transcript.findLast((entry) => entry.role === "assistant");
    if (lastAssistant?.audioDelivery === "submitted" && harness.isOutputPlaybackActive()) {
      entries.push(lastAssistant);
    }
    return entries;
  };
  const markInterruptedTranscript = (
    entries: RealtimeVoiceTranscriptEntry[] = captureInterruptedTranscript(),
  ) => {
    // Never rewrite generated text. Record delivery uncertainty separately so
    // the next consult does not assume the caller heard a cancelled sentence.
    for (const entry of entries) {
      if (entry.audioDelivery === "started" || entry.audioDelivery === "submitted") {
        entry.audioDelivery = "interrupted";
      }
    }
  };
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

  return {
    cancelActiveSpeech,
    cancelForConfirmedTurn,
    captureInterruptedTranscript,
    markInterruptedTranscript,
  };
}
