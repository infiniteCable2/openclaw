import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import type { TtsTelephonyStreamResult } from "../../tts/tts-runtime-types.js";
import { createSpeechTtsAudioStreamConverter, type SpeechAudioFormat } from "./audio-format.js";
import { createSpeechAudioPrefetch, MAX_SPEECH_PREFETCH_FRAME_BYTES } from "./audio-prefetch.js";
import { createSpeechStreamCleanup, type SpeechStreamCancellation } from "./stream-cleanup.js";

type PreparedSpeechAudio =
  | { skipped: true }
  | { error: unknown; controller: AbortController }
  | {
      result: TtsTelephonyStreamResult;
      controller: AbortController;
      resources: ReturnType<typeof createSpeechStreamCleanup>;
      audio: ReturnType<ReturnType<typeof createSpeechAudioPrefetch>["createChannel"]>;
    };

/** Prepare bounded audio in FIFO order; playback retains delivery/cleanup authority. */
export function createSpeechAudioPreparation(params: {
  audioFormat: SpeechAudioFormat;
  platformName: string;
  activeAborts: Set<AbortController>;
  activeReaders: Set<SpeechStreamCancellation>;
}) {
  let productionQueue = Promise.resolve();
  const slots: Promise<void>[] = [];
  const prefetch = createSpeechAudioPrefetch(
    params.audioFormat === "g711-ulaw-8khz" ? 8_000 : 48_000,
  );
  return {
    prepare(work: {
      isCurrent: () => boolean;
      synthesize: (signal: AbortSignal) => Promise<TtsTelephonyStreamResult>;
      playbackDone: Promise<void>;
    }): Promise<PreparedSpeechAudio> {
      // Also bound zero-byte, failed or headers-only results, not just audio.
      const slot = slots.length >= 3 ? slots.shift() : undefined;
      slots.push(work.playbackDone);
      const prepared = createDeferred<PreparedSpeechAudio>();
      productionQueue = productionQueue.then(async () => {
        await slot;
        if (!work.isCurrent()) {
          prepared.resolve({ skipped: true });
          return;
        }
        const controller = new AbortController();
        params.activeAborts.add(controller);
        const audio = prefetch.createChannel(controller.signal);
        let resources: ReturnType<typeof createSpeechStreamCleanup> | undefined;
        try {
          await audio.waitForCapacity();
          controller.signal.throwIfAborted();
          if (!work.isCurrent()) {
            throw new Error("Speech output is no longer current");
          }
          const result = await work.synthesize(controller.signal);
          resources = createSpeechStreamCleanup(result, params.activeReaders);
          prepared.resolve({ result, controller, resources, audio });
          if (!work.isCurrent() || controller.signal.aborted) {
            return;
          }
          if (!result.success || !result.audioStream || !result.sampleRate) {
            return;
          }
          const converter = createSpeechTtsAudioStreamConverter(
            result.sampleRate,
            params.audioFormat,
            result.outputFormat,
            params.platformName,
          );
          resources.open();
          // One producer prevents later results from filling the reservoir
          // ahead of the result the playback owner is waiting for.
          while (work.isCurrent() && !controller.signal.aborted) {
            await audio.waitForCapacity();
            if (!work.isCurrent() || controller.signal.aborted) {
              break;
            }
            const chunk = await resources.read();
            if (!work.isCurrent() || controller.signal.aborted) {
              break;
            }
            if (!chunk.done && chunk.value.byteLength > MAX_SPEECH_PREFETCH_FRAME_BYTES) {
              throw new Error("Speech provider audio frame exceeds the prefetch limit");
            }
            // Only natural EOF flushes the converter; cancellation drops its tail.
            const output = chunk.done
              ? converter.flush()
              : converter.process(Buffer.from(chunk.value));
            if (output.byteLength > 0) {
              await audio.push(output);
            }
            if (chunk.done) {
              break;
            }
          }
        } catch (error) {
          if (!resources) {
            prepared.resolve({ error, controller });
            audio.close();
          } else {
            audio.finish({ error });
          }
        } finally {
          audio.finish();
        }
      });
      return prepared.promise;
    },
  };
}
