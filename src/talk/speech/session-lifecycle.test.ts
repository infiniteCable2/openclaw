import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSpeechSessionLifecycle } from "./session-lifecycle.js";
import { playSpeechWaitingAudio } from "./waiting-audio.js";

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
    const writeStarted = createDeferred();
    const writeReleased = createDeferred();
    const waitingStopStarted = createDeferred();
    const controller = new AbortController();
    const playback = playSpeechWaitingAudio({
      audio: { pcm: Buffer.alloc(960), frameBytes: 960, startDelayMs: 0, resumeDelayMs: 800 },
      signal: controller.signal,
      transport: {
        async writeOutput() {
          writeStarted.resolve();
          await writeReleased.promise;
        },
      },
    });
    await writeStarted.promise;
    const { resources, lifecycle } = createLifecycle({
      stopWaiting: vi.fn(async () => {
        controller.abort();
        waitingStopStarted.resolve();
        await playback;
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
      expect(resources.disposeTransport).toHaveBeenCalledTimes(1);
      expect(resources.publishClosed).toHaveBeenCalledTimes(1);
    } finally {
      // Settle the admitted write even when the ordering assertion fails.
      controller.abort();
      writeReleased.resolve();
      await stopping;
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
