import type { createSpeechInputMetadata } from "./session-input-identity.js";
import type { SpeechActiveConsult } from "./types.js";
import type { createSpeechVideoInput } from "./video-input.js";

/** Shipped delegated-meeting talkback retains its own existing acceptance contract. */
export function admitLegacySpeechInput(params: {
  text: string;
  metadata: ReturnType<ReturnType<typeof createSpeechInputMetadata>["capture"]>;
  onsetConsult?: SpeechActiveConsult;
  hasOnset: boolean;
  getConsult(): SpeechActiveConsult | undefined;
  generation: number;
  isStopped(): boolean;
  enqueue(): boolean;
  releaseOnset?: () => void;
  video: ReturnType<typeof createSpeechVideoInput>;
  onUnconfirmed(): void;
}) {
  const { metadata, video } = params;
  const snapshot = metadata.snapshot;
  const enqueueInput = () => {
    if (!params.enqueue()) {
      snapshot?.release();
    }
  };
  // A delayed decoder result cannot steer whichever replacement run is active now.
  const consult = params.hasOnset ? params.onsetConsult : params.getConsult();
  if (!consult || consult !== params.getConsult()) {
    enqueueInput();
    params.releaseOnset?.();
    return;
  }
  const control = consult.control;
  consult.admissions = consult.admissions
    .then(async () => {
      if (params.isStopped()) {
        return;
      }
      if (consult.followupOnly) {
        enqueueInput();
        return;
      }
      // Commitment needs the held native loop to resume. Release its acoustic
      // reservation on queue acceptance, not on the later transcript commit.
      const frameInput = await video.prepare(snapshot);
      if (params.isStopped()) {
        return;
      }
      const inputText = frameInput.context
        ? `${params.text}\n\n${frameInput.context}`
        : params.text;
      const outcome = await control?.(inputText, params.releaseOnset, {
        inputId: metadata.inputId,
        purpose: "steering",
        images: frameInput.images,
      });
      if (params.isStopped()) {
        return;
      }
      if (outcome?.queued) {
        // queued=true also covers uncertain commitment: never resubmit it.
        consult.adoptedGeneration = params.generation;
        consult.unconfirmed ||= !outcome.ok;
        consult.followupOnly ||= !outcome.ok;
        if (snapshot) {
          consult.releaseVideo.add(snapshot.release);
        }
      } else {
        // Once B waits behind A, C must not overtake B by steering into A.
        consult.followupOnly = true;
        enqueueInput();
      }
    })
    .catch(() => {
      // An exception cannot prove non-adoption of potentially write-capable work.
      consult.unconfirmed = true;
      consult.followupOnly = true;
      if (snapshot) {
        consult.releaseVideo.add(snapshot.release);
      }
      params.onUnconfirmed();
    })
    .finally(() => params.releaseOnset?.());
}
