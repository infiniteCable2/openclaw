import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSpeechWaitingController } from "./waiting-controller.js";

describe("waiting playback stop custody", () => {
  it("joins the already started stop after turn retirement without stopping newer playback", async () => {
    const pending = createDeferredCore();
    const stop = vi.fn(() => pending.promise);
    const schedule = vi.fn();
    const controller = createSpeechWaitingController({
      playback: { stop, schedule },
      isStopped: () => false,
      canStart: () => false,
      resumeDelayMs: 800,
      onError: vi.fn(),
    });
    controller.stopInBackground();
    await controller.stop(0); // A stale owner must not replace the real pending stop.
    let joined = false;
    const joining = controller.joinStop().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
    pending.resolve();
    await joining;
    expect(joined).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });
});
