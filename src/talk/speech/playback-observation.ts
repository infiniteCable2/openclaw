import type { ReplySpeechRunBinding } from "../../auto-reply/reply/reply-speech-presentation.js";
import type { SpeechUtterance } from "./output.js";

/** Connection-owned media facts, never task completion, sender identity or proof of hearing. */
export type SpeechPlaybackObservation = {
  version: 1;
  inputId: string;
  outputGeneration: number;
  onsetAtMs?: number;
  preceding: {
    runId: string;
    sessionId: string;
    inputId: string;
    outputGeneration: number;
    runActiveAtOnset: boolean;
    playbackActiveAtOnset: boolean;
    playbackStarted: boolean;
    pendingOutput: boolean;
    unplayedResult: boolean;
    failed: boolean;
    segments: { unplayed: number; started: number; submitted: number; interrupted: number };
  };
};

export type SpeechPlaybackSnapshot = Omit<
  SpeechPlaybackObservation,
  "version" | "inputId" | "outputGeneration"
>;

/** Snapshot only this native run's original output; never copy generated or user text. */
export function captureSpeechPlaybackObservation(params: {
  source: {
    binding: Pick<ReplySpeechRunBinding, "runId" | "sessionId">;
    inputId: string;
    generation: number;
    utterance: SpeechUtterance;
    unplayedResult?: boolean;
  };
  runActive: boolean;
  playbackActive: boolean;
  onsetAtMs?: number;
}): SpeechPlaybackSnapshot | undefined {
  const { source } = params;
  const identities = [source.binding.runId, source.binding.sessionId, source.inputId];
  if (identities.some((id) => !id || id.length > 256)) {
    return undefined;
  }
  const segments = { unplayed: 0, started: 0, submitted: 0, interrupted: 0 };
  for (const entry of source.utterance.transcriptEntries) {
    if (entry.audioDelivery) {
      segments[entry.audioDelivery] += 1;
    }
  }
  return {
    ...(Number.isFinite(params.onsetAtMs) ? { onsetAtMs: params.onsetAtMs } : {}),
    preceding: {
      runId: source.binding.runId,
      sessionId: source.binding.sessionId,
      inputId: source.inputId,
      outputGeneration: source.generation,
      runActiveAtOnset: params.runActive,
      playbackActiveAtOnset: params.playbackActive,
      playbackStarted: source.utterance.playbackStarted,
      pendingOutput:
        source.unplayedResult === true ||
        (params.runActive && source.utterance.chunks.length === 0) ||
        segments.unplayed > 0 ||
        segments.started > 0,
      unplayedResult: source.unplayedResult === true,
      failed: source.utterance.failed,
      segments,
    },
  };
}
