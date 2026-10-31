import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";

const monitorTaskSignal = new AsyncLocalStorage<AbortSignal>();

export function getMatrixMonitorTaskSignal(): AbortSignal | undefined {
  return monitorTaskSignal.getStore();
}

export function createMatrixMonitorTaskRunner(params: {
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
}) {
  const inFlight = new Set<Promise<void>>();
  const retainedCleanup = new Set<() => Promise<void>>();
  const shutdownController = new AbortController();
  let closed = false;

  const runDetachedTask = (label: string, task: () => Promise<void>): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    // Retained descendants keep the runner's shutdown signal after their task settles.
    const trackedTask: Promise<void> = monitorTaskSignal
      .run(shutdownController.signal, () => Promise.resolve().then(task))
      .catch((error: unknown) => {
        const message = String(error);
        params.logVerboseMessage(`matrix: ${label} failed (${message})`);
        params.logger.warn("matrix background task failed", {
          task: label,
          error: message,
        });
      })
      .finally(() => {
        inFlight.delete(trackedTask);
      });
    inFlight.add(trackedTask);
    return trackedTask;
  };

  const waitForIdle = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.allSettled(inFlight);
    }
    if (closed) {
      const failures: unknown[] = [];
      for (const close of retainedCleanup) {
        try {
          await close();
          retainedCleanup.delete(close);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Matrix retained account cleanup remains pending");
      }
    }
  };

  return {
    close: () => {
      closed = true;
      shutdownController.abort();
    },
    runDetachedTask,
    retainCleanup: (close: () => Promise<void>) => {
      retainedCleanup.add(close);
      return () => {
        retainedCleanup.delete(close);
      };
    },
    waitForIdle,
  };
}
