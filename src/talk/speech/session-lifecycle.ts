import { formatErrorMessage } from "../../infra/errors.js";
import type { RuntimeLogger } from "../../plugins/runtime/types.js";

/** Own teardown progress: fence once, retain failures, retry only pending resources. */
export function createSpeechSessionLifecycle(params: {
  logger: RuntimeLogger;
  logScope: string;
  fence: () => void;
  closeTranscription: () => void | Promise<void>;
  stopWaiting: () => Promise<void>;
  drainOutput: () => Promise<void>;
  stopTransport: () => Promise<void>;
  disposeTransport: () => Promise<void>;
  publishClosed: () => void;
}) {
  let fenced = false;
  let closedPublished = false;
  let stopPromise: Promise<void> | undefined;
  const resources = {
    closeTranscription: () => params.closeTranscription(),
    stopWaiting: () => params.stopWaiting(),
    drainOutput: () => params.drainOutput(),
    stopTransport: () => params.stopTransport(),
    disposeTransport: () => params.disposeTransport(),
  };
  const pending = new Set<() => void | Promise<void>>([
    resources.closeTranscription,
    resources.stopWaiting,
    resources.drainOutput,
    resources.stopTransport,
    resources.disposeTransport,
  ]);

  const stop = async () => {
    if (!fenced) {
      fenced = true;
      params.fence();
    }
    if (stopPromise) {
      return stopPromise;
    }
    const cleanup = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const release = async (resource: () => void | Promise<void>) => {
        if (!pending.has(resource)) {
          return;
        }
        try {
          await resource();
          pending.delete(resource);
        } catch (error) {
          failures.push(error);
        }
      };
      await release(resources.closeTranscription);
      // Closing capture may unblock an admitted sink write. Start it before
      // joining either waiting playback or speech output; both own sink writes.
      const captureStopped = release(resources.stopTransport);
      const waitingStopped = release(resources.stopWaiting);
      await release(resources.drainOutput);
      await Promise.all([captureStopped, waitingStopped]);
      // Any failed cleanup retains custody. Disposal cannot run ahead of an
      // input, transcription, waiting-playback or speech-output owner.
      if (
        !pending.has(resources.closeTranscription) &&
        !pending.has(resources.stopWaiting) &&
        !pending.has(resources.stopTransport) &&
        !pending.has(resources.drainOutput)
      ) {
        await release(resources.disposeTransport);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Speech session resources did not close");
      }
      if (!closedPublished) {
        params.publishClosed();
        closedPublished = true;
      }
    });
    stopPromise = cleanup;
    try {
      await cleanup;
    } finally {
      if (stopPromise === cleanup) {
        stopPromise = undefined;
      }
    }
  };
  const stopAfterFailure = (source: string) => {
    void stop().catch((error: unknown) => {
      params.logger.warn(
        `${params.logScope} ${source} cleanup failed: ${formatErrorMessage(error)}`,
      );
    });
  };
  return {
    stop,
    stopAfterFailure,
    fail(source: string, error: unknown) {
      if (fenced) {
        return;
      }
      params.logger.warn(`${params.logScope} ${source} failed: ${formatErrorMessage(error)}`);
      stopAfterFailure(source);
    },
    isTranscriptionClosed: () => !pending.has(resources.closeTranscription),
  };
}
