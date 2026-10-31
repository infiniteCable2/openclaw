// Runtime config tests cover plugin runtime config normalization and lookup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";

const getRuntimeConfigMock = vi.fn();
const mutateConfigFileMock = vi.fn();
const replaceConfigFileMock = vi.fn();

vi.mock("../../config/io.runtime.js", () => ({
  getRuntimeConfig: () => getRuntimeConfigMock(),
}));

vi.mock("../../config/mutate.js", () => ({
  mutateConfigFile: (...args: unknown[]) => mutateConfigFileMock(...args),
  replaceConfigFile: (...args: unknown[]) => replaceConfigFileMock(...args),
}));

const { createRuntimeConfig } = await import("./runtime-config.js");

describe("createRuntimeConfig", () => {
  beforeEach(() => {
    getRuntimeConfigMock.mockReset();
    mutateConfigFileMock.mockReset();
    replaceConfigFileMock.mockReset();
    getRuntimeConfigMock.mockReturnValue({ plugins: {} });
  });

  it("reads config from the runtime snapshot", () => {
    const runtimeConfig = { plugins: { entries: {} } };
    getRuntimeConfigMock.mockReturnValue(runtimeConfig);

    expect(createRuntimeConfig().current()).toBe(runtimeConfig);
  });

  it("observes installed config publications without session or transcript churn", () => {
    const listener = vi.fn();
    const unsubscribe = createRuntimeConfig().subscribe(listener);
    try {
      sessionChanges.emit({ sessionKey: "agent:example:main", scope: "runtime" });
      sessionChanges.emit({ all: true, scope: "profiles" });
      expect(listener).not.toHaveBeenCalled();
      sessionChanges.emit({ all: true, scope: "config" });
      sessionChanges.emit({ all: true, scope: "config-profiles" });
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
    sessionChanges.emit({ all: true, scope: "config" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("exposes canonical mutation helpers", async () => {
    mutateConfigFileMock.mockResolvedValue({ result: "updated" });
    replaceConfigFileMock.mockResolvedValue({ persistedHash: "hash" });
    const configApi = createRuntimeConfig();
    const mutateParams = { mutate: vi.fn() };
    const replaceParams = { nextConfig: { plugins: {} } };

    await expect(configApi.mutateConfigFile(mutateParams as never)).resolves.toEqual({
      result: "updated",
    });
    await expect(configApi.replaceConfigFile(replaceParams as never)).resolves.toEqual({
      persistedHash: "hash",
    });
    expect(mutateConfigFileMock).toHaveBeenCalledWith(mutateParams);
    expect(replaceConfigFileMock).toHaveBeenCalledWith(replaceParams);
  });
});
