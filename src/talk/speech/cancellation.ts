import type { RealtimeVoiceSessionHarness } from "../realtime-session-harness.js";
import type { RealtimeVoiceTranscriptEntry } from "../session-log-runtime.js";
import type { createSpeechBargeInGate } from "./output-gate.js";
import type { SpeechStreamCancellation } from "./stream-cleanup.js";
import { normalizeSpeechPromptText } from "./support.js";

/** A confirmed caller turn ends both queued output and any in-flight synthesis. */
export function createSpeechCancellation(params: {
  harness: () => RealtimeVoiceSessionHarness;
  activeTtsAborts: Set<AbortController>;
  activeTtsReaders: Set<SpeechStreamCancellation>;
  bargeInGate: ReturnType<typeof createSpeechBargeInGate>;
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
  const recordUnplayedAnswer = (entries: readonly RealtimeVoiceTranscriptEntry[], text: string) => {
    const harness = params.harness();
    let remaining = normalizeSpeechPromptText(text) ?? "";
    // Streaming already recorded this utterance's chunks with their individual
    // delivery facts. Keep those facts, including commentary absent from the
    // final answer, and append only the final text they do not already cover.
    // Never deduplicate against another turn or an entry evicted from history.
    for (const entry of entries) {
      if (!harness.transcript.includes(entry) || !remaining.startsWith(entry.text)) {
        continue;
      }
      const suffix = remaining.slice(entry.text.length);
      if (suffix && !/^\s/u.test(suffix)) {
        continue;
      }
      remaining = suffix.trimStart();
    }
    if (remaining) {
      harness.recordTranscript("assistant", remaining).audioDelivery = "unplayed";
    }
  };
  const removeProvisionalTranscriptEntries = (entries: RealtimeVoiceTranscriptEntry[]) => {
    const harness = params.harness();
    for (const entry of entries) {
      const index = harness.transcript.indexOf(entry);
      if (index >= 0) {
        harness.transcript.splice(index, 1);
      }
    }
    entries.length = 0;
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
    recordUnplayedAnswer,
    removeProvisionalTranscriptEntries,
  };
}
