import type { RealtimeTranscriptionSessionCreateRequest } from "../../realtime-transcription/provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../realtime-session-harness.js";
import type { RealtimeVoiceTranscriptEntry } from "../session-log-runtime.js";
import type { createSpeechCancellation } from "./cancellation.js";
import type { createSpeechInputOnset } from "./input-onset.js";
import type { createNativeSpeechInput } from "./native-input.js";
import type { createSpeechBargeInGate } from "./output-gate.js";
import type { SpeechPlaybackSnapshot } from "./playback-observation.js";
import type { SpeechActiveConsult, SpeechSessionStartParams } from "./types.js";
import type { createSpeechVideoInput } from "./video-input.js";
import type { createSpeechWaitingController } from "./waiting-controller.js";

export type SpeechInputOnsetSnapshot = {
  consult: SpeechActiveConsult | undefined;
  nativeRun: ReturnType<ReturnType<typeof createNativeSpeechInput>["captureRun"]>;
  nativePlayback: SpeechPlaybackSnapshot | undefined;
  speechStart: NonNullable<RealtimeVoiceTranscriptEntry["speechStart"]>;
  interruptedEntries: RealtimeVoiceTranscriptEntry[];
  startedAtMs: number;
};

/** Capture the existing onset owners in their original synchronous callback order. */
export function createSpeechSessionInputObservers(params: {
  isStopped(): boolean;
  onActivity: SpeechSessionStartParams["onActivity"];
  observeActivity: NonNullable<RealtimeTranscriptionSessionCreateRequest["onSpeechActivity"]>;
  observeProcessing: NonNullable<RealtimeTranscriptionSessionCreateRequest["onProcessing"]>;
  onFailure(): void;
  video: Pick<ReturnType<typeof createSpeechVideoInput>, "begin" | "settle">;
  inputOnset: ReturnType<typeof createSpeechInputOnset<SpeechInputOnsetSnapshot>>;
  bargeInGate: Pick<
    ReturnType<typeof createSpeechBargeInGate>,
    "onSpeechActivity" | "onProcessing"
  >;
  waiting: Pick<ReturnType<typeof createSpeechWaitingController>, "onProcessing">;
  harness: Pick<
    RealtimeVoiceSessionHarness,
    "isOutputPlaybackActive" | "isOutputPlaybackWindowActive"
  >;
  speechCancellation: Pick<
    ReturnType<typeof createSpeechCancellation>,
    "captureInterruptedTranscript"
  >;
  getConsult(): SpeechActiveConsult | undefined;
  getNativeInput():
    | Pick<ReturnType<typeof createNativeSpeechInput>, "captureRun" | "capturePlayback">
    | undefined;
  getResponseQuestion(): string | undefined;
  activeTtsAborts: Readonly<{ size: number }>;
  activeTtsReaders: Readonly<{ size: number }>;
}): Pick<RealtimeTranscriptionSessionCreateRequest, "onSpeechActivity" | "onProcessing"> {
  return {
    onSpeechActivity(event) {
      if (params.isStopped()) {
        return;
      }
      params.observeActivity(event);
      if (event.state === "candidate") {
        params.onActivity?.("sensing");
        try {
          const startedAtMs = Date.now();
          params.video.begin(event.utteranceId, startedAtMs);
          params.inputOnset.begin(event.utteranceId, {
            consult: params.getConsult(),
            nativeRun: params.getNativeInput()?.captureRun(),
            nativePlayback: params
              .getNativeInput()
              ?.capturePlayback(startedAtMs, params.harness.isOutputPlaybackActive()),
            interruptedEntries: params.speechCancellation.captureInterruptedTranscript(),
            speechStart: {
              at: new Date(startedAtMs).toISOString(),
              precedingRequest:
                params.getConsult()?.question ??
                (params.activeTtsAborts.size + params.activeTtsReaders.size > 0 ||
                params.harness.isOutputPlaybackWindowActive()
                  ? params.getResponseQuestion()
                  : undefined),
            },
            startedAtMs,
          });
        } catch {
          params.onFailure();
          return;
        }
      } else if (event.state === "rejected") {
        params.video.settle(event.utteranceId);
        params.onActivity?.("listening");
        params.inputOnset.settle(event.utteranceId);
      }
      params.bargeInGate.onSpeechActivity(event);
    },
    onProcessing(event) {
      params.observeProcessing(event);
      if (event.state === "started") {
        params.onActivity?.("processing");
      } else if (event.state === "speech-confirmed") {
        params.onActivity?.("hearing");
      } else if (event.state === "transcribed") {
        params.onActivity?.("processing");
      } else if (["empty", "failed", "cancelled"].includes(event.state)) {
        params.onActivity?.("listening");
      }
      params.waiting.onProcessing(event);
      // Confirmation can precede an empty decoder result; the gate retains output custody.
      params.bargeInGate.onProcessing(event);
      if (["transcribed", "empty", "failed", "cancelled"].includes(event.state)) {
        params.inputOnset.settle(event.utteranceId);
      }
      if (["empty", "failed", "cancelled"].includes(event.state)) {
        params.video.settle(event.utteranceId);
      }
    },
  };
}
