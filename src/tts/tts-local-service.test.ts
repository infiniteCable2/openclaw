import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureProviderLocalServiceMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/provider-local-service.js", () => ({
  ensureProviderLocalService: ensureProviderLocalServiceMock,
}));

const { acquireSpeechProviderLocalService } = await import("./tts-local-service.js");

describe("speech provider local service", () => {
  beforeEach(() => {
    ensureProviderLocalServiceMock.mockReset();
  });

  it("does nothing when the provider has no local service", async () => {
    await expect(
      acquireSpeechProviderLocalService({
        providerId: "openai",
        providerConfig: { baseUrl: "http://127.0.0.1:8080/v1" },
      }),
    ).resolves.toBeUndefined();
    expect(ensureProviderLocalServiceMock).not.toHaveBeenCalled();
  });

  it("leases a namespaced provider service at the configured endpoint", async () => {
    const lease = { release: vi.fn() };
    ensureProviderLocalServiceMock.mockResolvedValue(lease);
    const localService = {
      command: "C:\\speech\\server.exe",
      args: ["--port", "8080"],
      healthUrl: "http://127.0.0.1:8080/health",
      idleStopMs: 30_000,
    };

    await expect(
      acquireSpeechProviderLocalService({
        providerId: "local-speech",
        providerConfig: {
          baseUrl: " http://127.0.0.1:8080/v1 ",
          localService,
        },
      }),
    ).resolves.toBe(lease);
    expect(ensureProviderLocalServiceMock).toHaveBeenCalledWith(
      {
        providerId: "local-speech",
        baseUrl: "http://127.0.0.1:8080/v1",
        service: localService,
      },
      undefined,
    );
  });

  it("requires an endpoint when local process management is enabled", async () => {
    await expect(
      acquireSpeechProviderLocalService({
        providerId: "local-speech",
        providerConfig: { localService: { command: "C:\\speech\\server.exe" } },
      }),
    ).rejects.toThrow("tts.providers.local-speech.baseUrl is required with localService");
  });
});
