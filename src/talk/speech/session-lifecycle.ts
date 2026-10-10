import { formatErrorMessage } from "../../infra/errors.js";
import type { RuntimeLogger } from "../../plugins/runtime/types.js";

/** Own teardown progress: fence once, retain failures, retry only pending resources. */
export function createSpeechSessionLifecycle(params: {
  logger: RuntimeLogger;
  logScope: string;
  fence(): void;
  closeTranscription(): void;
  stopWaiting(): Promise<void>;
  drainOutput(): Promise<void>;
  stopTransport(): Promise<void>;
  disposeTransport(): Promise<void>;
  publishClosed(): void;
}) {
  let fenced = false;
  let closedPublished = false;
  let stopPromise: Promise<void> | undefined;
  const pending = new Set([
    params.closeTranscription,
    params.stopWaiting,
    params.drainOutput,
    params.stopTransport,
    params.disposeTransport,
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
      await release(params.closeTranscription);
      await release(params.stopWaiting);
      // Closing capture may unblock an admitted sink write. Start it before
      // draining output; disposal must wait until that work has settled.
      const captureStopped = release(params.stopTransport);
      await release(params.drainOutput);
      await captureStopped;
      // Failed capture/output cleanup still owns resources. Disposal cannot
      // run ahead of either owner or falsely confirm a closed session.
      if (!pending.has(params.stopTransport) && !pending.has(params.drainOutput)) {
        await release(params.disposeTransport);
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
  return {
    stop,
    stopAfterFailure(source: string) {
      void stop().catch((error: unknown) => {
        params.logger.warn(
          `${params.logScope} ${source} cleanup failed: ${formatErrorMessage(error)}`,
        );
      });
    },
    isTranscriptionClosed: () => !pending.has(params.closeTranscription),
  };
}
