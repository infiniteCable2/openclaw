import { afterEach, expect, it, vi } from "vitest";
import {
  acquireSpeechProviderLocalServiceMock,
  createMockSpeechProvider,
  installSpeechProviders,
  synthesizeMock,
  synthesizeSpeech,
  textToSpeechStream,
  resetTtsRuntime,
} from "./tts-runtime.test-support.js";

afterEach(() => resetTtsRuntime());
it("prepares source-slice segments from the selected model profile before buffered synthesis", async () => {
  const profile = {
    minChars: 0,
    targetWords: 32,
    maxWords: 45,
    maxChars: 400,
    pauses: { paragraph: 320, sentence: 180, clause: 80, fragment: 60 },
  };
  const order: string[] = [];
  installSpeechProviders([
    createMockSpeechProvider("mock", {
      prepareSegmentationProfile: async () => {
        order.push("prepare");
      },
      getSegmentationProfile: () => {
        order.push("read");
        return profile;
      },
      synthesize: async (request) => {
        order.push("synthesize");
        expect(request.segments).toEqual([
          { text: "Hallo Welt.", pauseMs: 320 },
          { text: "Noch ein Absatz.", pauseMs: 180 },
        ]);
        return {
          audioBuffer: Buffer.from("voice"),
          fileExtension: ".ogg",
          outputFormat: "ogg",
          voiceCompatible: true,
        };
      },
    }),
  ]);
  const result = await synthesizeSpeech({
    text: "Hallo Welt.\n\nNoch ein Absatz.",
    cfg: { tts: { enabled: true, provider: "mock" } },
    disableFallback: true,
  });
  expect(result.success).toBe(true);
  expect(order).toEqual(["prepare", "read", "synthesize"]);
});

it("refuses synthesis when an opted-in model profile was not admitted", async () => {
  installSpeechProviders([
    createMockSpeechProvider("mock", {
      prepareSegmentationProfile: async () => undefined,
      getSegmentationProfile: () => undefined,
    }),
  ]);
  const result = await synthesizeSpeech({
    text: "Hallo Welt.",
    cfg: { tts: { enabled: true, provider: "mock" } },
    disableFallback: true,
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain("segmentation budgets were not admitted");
  expect(synthesizeMock).not.toHaveBeenCalled();
});

it("holds a local speech service lease around buffered synthesis", async () => {
  const releaseLocalService = vi.fn();
  acquireSpeechProviderLocalServiceMock.mockResolvedValue({ release: releaseLocalService });
  const synthesize = vi.fn(async () => {
    expect(releaseLocalService).not.toHaveBeenCalled();
    return {
      audioBuffer: Buffer.from("voice"),
      fileExtension: ".ogg",
      outputFormat: "ogg",
      voiceCompatible: true,
    };
  });
  installSpeechProviders([
    createMockSpeechProvider("local-speech", {
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:8080/v1" }),
      synthesize,
    }),
  ]);
  const localService = {
    command: "C:\\speech\\server.exe",
    idleStopMs: 30_000,
  };

  const result = await synthesizeSpeech({
    text: "Lease the local speech server.",
    cfg: {
      tts: {
        enabled: true,
        provider: "local-speech",
        providers: {
          "local-speech": {
            baseUrl: "http://127.0.0.1:8080/v1",
            localService,
          },
        },
      },
    },
    disableFallback: true,
  });

  expect(result.success).toBe(true);
  expect(acquireSpeechProviderLocalServiceMock).toHaveBeenCalledWith({
    providerId: "local-speech",
    providerConfig: expect.objectContaining({
      baseUrl: "http://127.0.0.1:8080/v1",
      localService,
    }),
  });
  expect(releaseLocalService).toHaveBeenCalledOnce();
});

it("releases a failed provider lease before trying the TTS fallback", async () => {
  const primaryRelease = vi.fn();
  const fallbackRelease = vi.fn();
  acquireSpeechProviderLocalServiceMock
    .mockResolvedValueOnce({ release: primaryRelease })
    .mockResolvedValueOnce({ release: fallbackRelease });
  const primarySynthesize = vi.fn(async () => {
    throw new Error("local speech failed");
  });
  const fallbackSynthesize = vi.fn(async () => {
    expect(primaryRelease).toHaveBeenCalledOnce();
    return {
      audioBuffer: Buffer.from("fallback"),
      fileExtension: ".ogg",
      outputFormat: "ogg",
      voiceCompatible: true,
    };
  });
  installSpeechProviders([
    createMockSpeechProvider("primary", { autoSelectOrder: 1, synthesize: primarySynthesize }),
    createMockSpeechProvider("fallback", {
      autoSelectOrder: 2,
      synthesize: fallbackSynthesize,
    }),
  ]);

  const result = await synthesizeSpeech({
    text: "Release before fallback.",
    cfg: { tts: { enabled: true, provider: "primary" } },
  });

  expect(result.success).toBe(true);
  expect(result.provider).toBe("fallback");
  expect(primaryRelease).toHaveBeenCalledOnce();
  expect(fallbackRelease).toHaveBeenCalledOnce();
});

it("retains a local speech service until streaming transport release", async () => {
  const releaseLocalService = vi.fn();
  const releaseTransport = vi.fn(async () => {});
  acquireSpeechProviderLocalServiceMock.mockResolvedValue({ release: releaseLocalService });
  installSpeechProviders([
    createMockSpeechProvider("streaming", {
      streamSynthesize: vi.fn(async () => ({
        audioStream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        fileExtension: ".pcm",
        outputFormat: "pcm",
        voiceCompatible: false,
        release: releaseTransport,
      })),
    }),
  ]);

  const result = await textToSpeechStream({
    text: "Keep the service alive for playback.",
    cfg: { tts: { enabled: true, provider: "streaming" } },
    disableFallback: true,
  });

  expect(result.success).toBe(true);
  expect(releaseLocalService).not.toHaveBeenCalled();
  await result.release?.();
  await result.release?.();
  expect(releaseTransport).toHaveBeenCalledOnce();
  expect(releaseLocalService).toHaveBeenCalledOnce();
});
