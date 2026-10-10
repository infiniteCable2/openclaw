import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSpeechSessionLifecycle } from "./session-lifecycle.js";
import { createSpeechWaitingAudioPlayback } from "./waiting-audio.js";

// This native launcher leaves Node Promise timers real; bind only their clock
// to Sinon for this owner's void-valued delays and retain cancellation through
// the existing abort-race owner.
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  const { racePromiseWithAbortSignal } = await import("../../infra/abort-signal.js");
  return {
    ...actual,
    async setTimeout(
      delay?: Parameters<typeof actual.setTimeout>[0],
      _value?: void,
      options?: Parameters<typeof actual.setTimeout>[2],
    ): Promise<void> {
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      try {
        return await racePromiseWithAbortSignal(
          () =>
            new Promise<void>((resolve) => {
              const scheduledTimer = globalThis.setTimeout(resolve, delay);
              timer = scheduledTimer;
              if (options?.ref === false) {
                scheduledTimer.unref();
              }
            }),
          options?.signal,
        );
      } finally {
        globalThis.clearTimeout(timer);
      }
    },
  };
});

afterEach(() => vi.useRealTimers());

function createLifecycle(
  overrides: Partial<Parameters<typeof createSpeechSessionLifecycle>[0]> = {},
) {
  const resources = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logScope: "synthetic-speech",
    fence: vi.fn(),
    closeTranscription: vi.fn(),
    stopWaiting: vi.fn(async () => undefined),
    drainOutput: vi.fn(async () => undefined),
    stopTransport: vi.fn(async () => undefined),
    disposeTransport: vi.fn(async () => undefined),
    publishClosed: vi.fn(),
    ...overrides,
  };
  return { resources, lifecycle: createSpeechSessionLifecycle(resources) };
}

describe("speech session teardown ownership", () => {
  it("stops capture before joining a backpressured waiting-audio write", async () => {
    vi.useFakeTimers();
    const writeStarted = createDeferred();
    const writeReleased = createDeferred();
    const waitingStopStarted = createDeferred();
    const clearOutput = vi.fn(async () => undefined);
    const onError = vi.fn();
    const playback = createSpeechWaitingAudioPlayback({
      audio: { pcm: Buffer.alloc(960), frameBytes: 960, startDelayMs: 0, resumeDelayMs: 800 },
      isStopped: () => false,
      onError,
      transport: {
        clearOutput,
        async writeOutput() {
          writeStarted.resolve();
          await writeReleased.promise;
        },
      },
    });
    playback.schedule();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersToNextTimerAsync();
    await writeStarted.promise;
    const disposeTransport = vi.fn(async () => undefined);
    const { resources, lifecycle } = createLifecycle({
      disposeTransport,
      stopWaiting: vi.fn(async () => {
        waitingStopStarted.resolve();
        await playback.stop();
      }),
      stopTransport: vi.fn(async () => {
        writeReleased.resolve();
      }),
    });
    const stopping = lifecycle.stop();
    try {
      await waitingStopStarted.promise;
      expect(resources.stopTransport).toHaveBeenCalledTimes(1);
      await stopping;
      expect(vi.getTimerCount()).toBe(0);
      expect(clearOutput).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(resources.disposeTransport).toHaveBeenCalledTimes(1);
      expect(clearOutput.mock.invocationCallOrder[0]).toBeLessThan(
        disposeTransport.mock.invocationCallOrder[0]!,
      );
      expect(resources.publishClosed).toHaveBeenCalledTimes(1);
    } finally {
      // Settle the admitted write even when the ordering assertion fails.
      writeReleased.resolve();
      await stopping;
      await playback.stop();
    }
  });

  it("retains failed waiting cleanup and retries it before transport disposal", async () => {
    const stopWaiting = vi.fn(async () => undefined);
    stopWaiting.mockRejectedValueOnce(new Error("waiting sink still owned"));
    const { resources, lifecycle } = createLifecycle({ stopWaiting });
    await expect(lifecycle.stop()).rejects.toThrow("Speech session resources did not close");
    expect(resources.disposeTransport).not.toHaveBeenCalled();
    expect(resources.publishClosed).not.toHaveBeenCalled();
    await lifecycle.stop();
    expect(stopWaiting).toHaveBeenCalledTimes(2);
    expect(resources.stopTransport).toHaveBeenCalledTimes(1);
    expect(resources.drainOutput).toHaveBeenCalledTimes(1);
    expect(resources.fence).toHaveBeenCalledTimes(1);
    expect(resources.disposeTransport).toHaveBeenCalledTimes(1);
    expect(resources.publishClosed).toHaveBeenCalledTimes(1);
  });

  it("keeps failed transcription custody until retry without repeating settled owners", async () => {
    const closeTranscription = vi.fn();
    closeTranscription.mockImplementationOnce(() => {
      throw new Error("transcription still owned");
    });
    const { resources, lifecycle } = createLifecycle({ closeTranscription });
    await expect(lifecycle.stop()).rejects.toThrow("Speech session resources did not close");
    expect(lifecycle.isTranscriptionClosed()).toBe(false);
    expect(resources.disposeTransport).not.toHaveBeenCalled();
    await lifecycle.stop();
    expect(lifecycle.isTranscriptionClosed()).toBe(true);
    expect(closeTranscription).toHaveBeenCalledTimes(2);
    expect(resources.stopTransport).toHaveBeenCalledTimes(1);
    expect(resources.stopWaiting).toHaveBeenCalledTimes(1);
    expect(resources.disposeTransport).toHaveBeenCalledTimes(1);
    expect(resources.publishClosed).toHaveBeenCalledTimes(1);
  });
});
