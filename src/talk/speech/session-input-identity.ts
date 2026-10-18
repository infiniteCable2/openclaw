import { randomUUID } from "node:crypto";
import type { createSpeechVideoInput } from "./video-input.js";

type SpeechVideoInput = ReturnType<typeof createSpeechVideoInput>;
type SpeechVideoSnapshot = ReturnType<SpeechVideoInput["capture"]>;

class SpeechInputMetadata {
  constructor(
    readonly inputId: string,
    readonly snapshot: SpeechVideoSnapshot,
  ) {}
}

/** Carry accepted input identity through the existing queue and its video custody. */
export function createSpeechInputMetadata(video: SpeechVideoInput) {
  const audioMergeKey = Symbol("speech-input");
  const read = (value: unknown): SpeechInputMetadata => {
    if (!(value instanceof SpeechInputMetadata)) {
      throw new Error("Speech input is missing its host identity");
    }
    return value;
  };
  return {
    capture(startedAtMs: number | undefined, utteranceId: string | undefined) {
      return new SpeechInputMetadata(
        utteranceId || randomUUID(),
        video.capture(startedAtMs ?? Date.now() - 2000, Date.now(), utteranceId),
      );
    },
    read(value: unknown) {
      const metadata = read(value);
      return {
        input: { inputId: metadata.inputId, purpose: "user" as const },
        snapshot: video.resolve(metadata.snapshot),
      };
    },
    queueOptions: {
      onDiscardMetadata(value: unknown) {
        video.resolve(read(value).snapshot)?.release();
      },
      metadataMergeKey(value: unknown) {
        const metadata = read(value);
        return video.source ? video.mergeKey(metadata.snapshot) : audioMergeKey;
      },
      mergeMetadata(left: unknown, right: unknown) {
        const first = read(left);
        const second = read(right);
        // Native transcript batching remains one input; its first receipt owns
        // the batch, while the existing video owner combines/releases snapshots.
        return new SpeechInputMetadata(
          first.inputId,
          video.source ? video.merge(first.snapshot, second.snapshot) : undefined,
        );
      },
    },
  };
}
