import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRelayProviderStartup } from "./provider-startup.js";

describe("actual provider startup context custody", () => {
  it("keeps original authorization until the actual connection settles", async () => {
    const gate = createDeferred();
    const assertCurrent = vi.fn();
    const release = vi.fn(async () => {});
    const startup = createRelayProviderStartup({ assertCurrent, release }, vi.fn());
    const connect = vi.fn(() => gate.promise);
    const pending = startup.connect({ connect });
    expect(connect).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    gate.resolve();
    await pending;
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
    startup.assertCurrent();
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("refuses a source revoked while connection configuration was pending", async () => {
    const gate = createDeferred();
    let current = true;
    const release = vi.fn(async () => {});
    const startup = createRelayProviderStartup(
      {
        assertCurrent: () => {
          if (!current) throw new Error("Original snapshot revoked");
        },
        release,
      },
      vi.fn(),
    );
    const pending = startup.connect({ connect: () => gate.promise });
    current = false;
    gate.resolve();
    await expect(pending).rejects.toThrow("revoked");
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves successful connection despite an auxiliary release error", async () => {
    const warn = vi.fn();
    const startup = createRelayProviderStartup(
      {
        assertCurrent: vi.fn(),
        release: vi.fn(async () => {
          throw new Error("Cleanup failure");
        }),
      },
      warn,
    );
    await expect(startup.connect({ connect: async () => {} })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not retry or rewrite the provider's original failed connection", async () => {
    const release = vi.fn(async () => {});
    const original = new Error("Provider rejected startup");
    const connect = vi.fn(async () => {
      throw original;
    });
    const startup = createRelayProviderStartup({ assertCurrent: vi.fn(), release }, vi.fn());
    await expect(startup.connect({ connect })).rejects.toBe(original);
    expect(connect).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
