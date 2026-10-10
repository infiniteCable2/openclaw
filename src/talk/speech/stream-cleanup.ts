import type { TtsTelephonyStreamResult } from "../../tts/tts-runtime-types.js";

export type SpeechStreamCancellation = { cancel(): Promise<void> };

/** Own an accepted stream's reader and provider hold until each release is confirmed. */
export function createSpeechStreamCleanup(
  result: TtsTelephonyStreamResult,
  active: Set<SpeechStreamCancellation>,
) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let terminal = false;
  let unlocked = false;
  let providerReleased = false;
  let cancellation: Promise<void> | undefined;
  let cancelFailure: { error: unknown } | undefined;
  let releaseAttempts = 0;
  const cancel = (): Promise<void> => {
    if (terminal || !reader) {
      return Promise.resolve();
    }
    return (cancellation ??= Promise.resolve()
      .then(() => reader?.cancel())
      .then(
        () => {
          terminal = true;
        },
        (error: unknown) => {
          cancelFailure = { error };
          throw error;
        },
      )
      .finally(() => {
        cancellation = undefined;
      }));
  };
  const owner: SpeechStreamCancellation = { cancel };
  return {
    open() {
      if (!result.audioStream) {
        throw new Error("Speech stream is unavailable");
      }
      reader = result.audioStream.getReader();
      active.add(owner);
    },
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (!reader) {
        throw new Error("Speech stream reader is not open");
      }
      try {
        const chunk = await reader.read();
        terminal ||= chunk.done;
        return chunk;
      } catch (error) {
        // ReadableStream error is terminal, unlike a failed source cancellation.
        terminal = true;
        throw error;
      }
    },
    async release() {
      const retry = releaseAttempts++ > 0;
      // Preparation may finish after cancellation, before playback opens a
      // reader. Own and cancel that available stream before releasing its hold.
      // An already locked stream remains under the provider's release contract.
      if (!reader && result.audioStream && !result.audioStream.locked) {
        reader = result.audioStream.getReader();
        active.add(owner);
      }
      // Reader.read() can reach done before the source's cancel promise settles.
      // Do not let that early terminal receipt release a still-unconfirmed hold.
      if (cancellation) {
        await cancellation;
      }
      if (cancelFailure) {
        if (!retry) {
          throw cancelFailure.error;
        }
        cancelFailure = undefined;
      }
      if (reader && !terminal) {
        await cancel();
      }
      if (reader && !unlocked) {
        reader.releaseLock();
        unlocked = true;
        active.delete(owner);
      }
      if (!providerReleased) {
        await result.release?.();
        providerReleased = true;
      }
    },
  };
}
