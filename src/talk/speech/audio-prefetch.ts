import { createDeferredCore as createDeferred } from "../../shared/deferred.js";

export const MAX_SPEECH_PREFETCH_FRAME_BYTES = 32 * 1024 * 1024;

/** One session-wide reservoir, independent of the transport's paced write. */
export function createSpeechAudioPrefetch(bytesPerSecond: number) {
  // Count alone is insufficient: a provider chunk can contain a whole sentence.
  // Slice only PCM transport buffers, never text, synthesis or expression units.
  const blockBytes = bytesPerSecond * 6;
  let bufferedBlocks = 0;
  let bufferedBytes = 0;
  let changed = createDeferred<void>();
  const notify = () => {
    const previous = changed;
    changed = createDeferred<void>();
    previous.resolve();
  };

  return {
    createChannel(signal: AbortSignal) {
      const queue: Buffer[] = [];
      let ended = false;
      let failure: { error: unknown } | undefined;
      let closed = false;
      const close = () => {
        closed = true;
        ended = true;
        bufferedBlocks -= queue.length;
        bufferedBytes -= queue.reduce((sum, audio) => sum + audio.byteLength, 0);
        queue.length = 0;
        signal.removeEventListener("abort", close);
        notify();
      };
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) {
        close();
      }
      return {
        async waitForCapacity() {
          while (!closed && (bufferedBlocks >= 2 || bufferedBytes >= blockBytes * 2)) {
            await changed.promise;
          }
          signal.throwIfAborted();
          if (closed) {
            throw new Error("Speech prefetch channel is closed");
          }
        },
        async push(audio: Buffer) {
          if (audio.byteLength > MAX_SPEECH_PREFETCH_FRAME_BYTES) {
            throw new Error("Speech provider audio frame exceeds the prefetch limit");
          }
          for (let offset = 0; offset < audio.byteLength; offset += blockBytes) {
            await this.waitForCapacity();
            // Capacity can resolve synchronously, but awaiting it yields to a
            // concurrent generation cancellation before the append resumes.
            signal.throwIfAborted();
            if (closed) {
              throw new Error("Speech prefetch channel is closed");
            }
            // Own only the admitted slice, not a view retaining a larger frame.
            const block = Buffer.from(audio.subarray(offset, offset + blockBytes));
            queue.push(block);
            bufferedBlocks += 1;
            bufferedBytes += block.byteLength;
            notify();
          }
        },
        async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
          for (;;) {
            const audio = queue.shift();
            if (audio) {
              bufferedBlocks -= 1;
              bufferedBytes -= audio.byteLength;
              notify();
              return { done: false, value: audio };
            }
            if (failure) {
              throw failure.error;
            }
            if (ended) {
              return { done: true, value: undefined };
            }
            await changed.promise;
          }
        },
        get hasBufferedAudio() {
          return queue.length > 0;
        },
        finish(error?: { error: unknown }) {
          failure ??= error;
          ended = true;
          notify();
        },
        close,
      };
    },
  };
}
