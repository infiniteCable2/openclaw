import { describe, expect, it, vi } from "vitest";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";

const registry = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn() }));
vi.mock("../../realtime-transcription/provider-registry.js", () => ({
  getRealtimeTranscriptionProvider: registry.get,
  listRealtimeTranscriptionProviders: registry.list,
}));

import { resolveSpeechTranscriptionProvider } from "./support.js";

const provider = {
  id: "synthetic-stt",
  aliases: ["synthetic-alias"],
  label: "Synthetic STT",
  isConfigured: () => true,
  createSession: vi.fn(),
} satisfies RealtimeTranscriptionProviderPlugin;

describe("speech transcription provider ownership", () => {
  it("uses targeted native lookup for an explicitly configured lazy provider", () => {
    registry.get.mockReset().mockReturnValue(provider);
    registry.list.mockReset();
    const fullConfig = {};
    const result = resolveSpeechTranscriptionProvider({
      config: {
        transcriptionProvider: "synthetic-alias",
        providers: { "synthetic-alias": { model: "synthetic-model" } },
      },
      fullConfig,
    });
    expect(registry.get).toHaveBeenCalledExactlyOnceWith("synthetic-alias", fullConfig);
    expect(registry.list).not.toHaveBeenCalled();
    expect(result).toEqual({ provider, providerConfig: { model: "synthetic-model" } });
  });

  it("cannot escape an injected operation scope for an explicitly missing provider", () => {
    registry.get.mockReset().mockReturnValue(provider);
    registry.list.mockReset().mockReturnValue([provider]);
    expect(() =>
      resolveSpeechTranscriptionProvider({
        config: { transcriptionProvider: "synthetic-stt", providers: {} },
        fullConfig: {},
        providers: [],
      }),
    ).toThrow('Realtime transcription provider "synthetic-stt" is not registered');
    expect(registry.get).not.toHaveBeenCalled();
    expect(registry.list).not.toHaveBeenCalled();
  });
});
