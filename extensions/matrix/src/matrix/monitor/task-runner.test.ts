import { describe, expect, it, vi } from "vitest";
import { createMatrixMonitorTaskRunner } from "./task-runner.js";

function fixture() {
  return createMatrixMonitorTaskRunner({
    logger: { info() {}, warn() {}, error() {} },
    logVerboseMessage() {},
  });
}

describe("Matrix account retained preparation custody", () => {
  it("keeps roots alive while idle and joins their cleanup on account retirement", async () => {
    const runner = fixture();
    const close = vi.fn(async () => {});
    runner.retainCleanup(close);
    await runner.waitForIdle();
    expect(close).not.toHaveBeenCalled();
    runner.close();
    await runner.waitForIdle();
    await runner.waitForIdle();
    expect(close).toHaveBeenCalledOnce();
  });

  it("joins cleanup retained by an already running preparation after shutdown", async () => {
    const runner = fixture();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const close = vi.fn(async () => {});
    const task = runner.runDetachedTask("synthetic preparation", async () => {
      entered.resolve();
      await gate.promise;
      runner.retainCleanup(close);
    });
    await entered.promise;
    runner.close();
    const draining = runner.waitForIdle();
    gate.resolve();
    await task;
    await draining;
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains failed native cleanup for retry without repeating settled sibling cleanup", async () => {
    const runner = fixture();
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("native cleanup deferred"))
      .mockResolvedValue(undefined);
    const healthy = vi.fn(async () => {});
    runner.retainCleanup(close);
    runner.retainCleanup(healthy);
    runner.close();
    await expect(runner.waitForIdle()).rejects.toThrow("cleanup remains pending");
    await runner.waitForIdle();
    expect(close).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledOnce();
  });
});
