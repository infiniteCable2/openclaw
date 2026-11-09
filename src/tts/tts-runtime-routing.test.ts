import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TIMER_TIMEOUT_MS,
  acquireSpeechProviderLocalServiceMock,
  buildTtsSystemPromptHint,
  createMockSpeechProvider,
  createTtsConfig,
  expectTtsPayloadResult,
  installSpeechProviders,
  listSpeechVoices,
  prepareTtsRequest,
  prefsPathFor,
  requireFirstCallParam,
  requireFirstSynthesisRequest,
  requireRecord,
  resetTtsRuntime,
  resolveTtsConfig,
  setTtsMachinePrefsPathResolver,
  setRuntimeConfigSnapshot,
  synthesizeMock,
  synthesizeSpeech,
  textToSpeech,
  textToSpeechCore,
  transcodeAudioBufferMock,
  type OpenClawConfig,
  type SpeechListVoicesRequest,
  type TtsConfig,
} from "./tts-runtime.test-support.js";
import * as ttsSettings from "./tts-settings.js";

const { resolveExplicitTtsOverridesAsync } = await import("./tts-request.js");

const mockConfig = (providerConfig: Record<string, unknown>): OpenClawConfig => ({
  tts: { enabled: true, provider: "mock", providers: { mock: providerConfig } },
});
const expectVoiceMemo = (mediaExtension: string) =>
  expectTtsPayloadResult({
    channel: "voice-memo-chat",
    prefsName: `voice-memo-${mediaExtension}`,
    text: "A native voice memo.",
    target: "audio-file",
    audioAsVoice: true,
    mediaExtension,
    providerResult: {
      audioBuffer: Buffer.from("mp3"),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    },
  });

describe("TTS runtime native voice-note routing", () => {
  afterEach(resetTtsRuntime);

  it("prefers the environment preference path over migrated machine state", () => {
    const previousEnvPath = process.env.OPENCLAW_TTS_PREFS;
    const envPath = prefsPathFor("env-override");
    setTtsMachinePrefsPathResolver(() => prefsPathFor("machine-state"));
    process.env.OPENCLAW_TTS_PREFS = envPath;
    try {
      expect(ttsSettings.resolveTtsPrefsPath(resolveTtsConfig({}))).toBe(envPath);
    } finally {
      if (previousEnvPath === undefined) {
        delete process.env.OPENCLAW_TTS_PREFS;
      } else {
        process.env.OPENCLAW_TTS_PREFS = previousEnvPath;
      }
    }
  });

  it("tells generic TTS guidance to defer to MEMORY voice-delivery instructions", () => {
    const hint = buildTtsSystemPromptHint(createTtsConfig("openclaw-speech-core-tts-hint-test"));

    expect(hint).toContain("Voice (TTS) is enabled.");
    expect(hint).toContain(
      "If workspace context (especially MEMORY.md) tells you not to use [[tts:...]] or to use a local/non-tagged voice workflow, follow that workspace instruction instead.",
    );
    expect(hint).toContain(
      "hidden TTS text may be a shorter spoken rendering but must not replace the complete visible answer.",
    );
    expect(hint).toContain("Keep the complete user-facing answer in normal visible text");
  });

  it("distinguishes inbound voice messages from ordinary audio files in TTS guidance", () => {
    const cfg = createTtsConfig("openclaw-speech-core-inbound-tts-hint-test");
    if (cfg.tts) {
      cfg.tts.auto = "inbound";
    }

    const hint = buildTtsSystemPromptHint(cfg);

    expect(hint).toContain("conversational voice message");
    expect(hint).toContain("ordinary audio-file attachment does not request an audio reply");
  });

  it("uses structured speech guidance for message-tool-only replies", () => {
    const hint = buildTtsSystemPromptHint(
      createTtsConfig("openclaw-speech-core-structured-tts-hint-test"),
      undefined,
      { messageToolOnly: true },
    );

    expect(hint).toContain("message(action=send) with voiceText");
    expect(hint).toContain("voiceProvider/voiceId");
    expect(hint).not.toContain("[[tts:");
  });

  it("prepares deep-merged surface config and directive inputs", async () => {
    const cfg: OpenClawConfig = {
      tts: {
        provider: "mock",
        modelOverrides: { allowProvider: false },
        providers: {
          mock: {
            model: "base-model",
            voiceSettings: { stability: 0.4 },
          },
        },
      },
    };

    const prepared = await prepareTtsRequest({
      cfg,
      override: {
        modelOverrides: { allowProvider: true },
        providers: {
          mock: {
            voice: "surface-voice",
            voiceSettings: { speed: 1.1 },
          },
        },
      },
      text: "Hello [[tts:text]]Speak this instead[[/tts:text]] caller",
    });

    expect(prepared.cfg).not.toBe(cfg);
    expect(prepared.cfg.tts?.providers?.mock).toEqual({
      model: "base-model",
      voice: "surface-voice",
      voiceSettings: { stability: 0.4, speed: 1.1 },
    });
    expect(prepared.cfg.tts?.modelOverrides?.allowProvider).toBe(true);
    expect(prepared.directives).toEqual({
      cleanedText: "Hello  caller",
      hasDirective: true,
      overrides: {
        ttsText: "Speak this instead",
      },
      ttsText: "Speak this instead",
      warnings: [],
    });
    expect(cfg.tts?.providers?.mock).toEqual({
      model: "base-model",
      voiceSettings: { stability: 0.4 },
    });
  });

  it("sanitizes blocked override keys while preparing TTS config", async () => {
    const prepared = await prepareTtsRequest({
      cfg: {
        tts: {
          provider: "mock",
          providers: { mock: { model: "base-model" } },
        },
      },
      override: JSON.parse(
        '{"__proto__":{"polluted":"top"},"providers":{"mock":{"voice":"safe","__proto__":{"polluted":"nested"}}}}',
      ) as TtsConfig,
      text: "[[tts:text]]Speak this instead[[/tts:text]]",
    });

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(prepared.cfg.tts).not.toHaveProperty("polluted");
    expect(prepared.cfg.tts?.providers?.mock).toEqual({
      model: "base-model",
      voice: "safe",
    });
    expect(prepared.directives.cleanedText).toBe("");
    expect(prepared.directives.ttsText).toBe("Speak this instead");
  });

  it("marks Discord auto TTS replies as native voice messages", async () => {
    await expectTtsPayloadResult({
      channel: "discord",
      prefsName: "openclaw-speech-core-tts-test",
      text: "This Discord reply should be delivered as a native voice note.",
      target: "voice-note",
      audioAsVoice: true,
    });
  });

  it("pre-transcodes synthesized mp3 to opus-in-CAF when the host can satisfy preferAudioFileFormat", async () => {
    transcodeAudioBufferMock.mockResolvedValueOnce({
      ok: true,
      buffer: Buffer.from("transcoded-caf"),
    });
    await expectTtsPayloadResult({
      channel: "voice-memo-chat",
      prefsName: "openclaw-speech-core-tts-voice-memo-caf-transcode-test",
      text: "This reply should be pre-transcoded to a native voice-memo CAF.",
      target: "audio-file",
      audioAsVoice: true,
      mediaExtension: "caf",
      providerResult: {
        audioBuffer: Buffer.from("mp3"),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      },
    });
    expect(transcodeAudioBufferMock).toHaveBeenCalledOnce();
    const transcodeRequest = requireRecord(
      requireFirstCallParam(transcodeAudioBufferMock.mock.calls as unknown[][], "transcode"),
      "transcode request",
    );
    expect(transcodeRequest.sourceExtension).toBe("mp3");
    expect(transcodeRequest.targetExtension).toBe("caf");
  });

  it("falls back to the original mp3 buffer when the host transcoder fails", async () => {
    transcodeAudioBufferMock.mockResolvedValueOnce({
      ok: false,
      reason: "transcoder-failed",
      detail: "exit-1",
    });
    // Even though the transcode failed, the original mp3 still satisfies the
    // channel audioFileFormats list, so the channel still flips audioAsVoice.
    // The user gets a voice memo bubble, possibly with bad duration, instead
    // of a regression. The failure is logged via the call site in tts.ts.
    await expectTtsPayloadResult({
      channel: "voice-memo-chat",
      prefsName: "openclaw-speech-core-tts-voice-memo-caf-fallback-test",
      text: "This reply should fall back to the original mp3.",
      target: "audio-file",
      audioAsVoice: true,
      mediaExtension: "mp3",
      providerResult: {
        audioBuffer: Buffer.from("mp3"),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      },
    });
  });

  it("uses the active runtime snapshot when source config still contains TTS SecretRefs", async () => {
    const sourceConfig = {
      tts: {
        enabled: true,
        provider: "mock",
        providers: {
          mock: {
            apiKey: { source: "exec", provider: "mockexec", id: "minimax/tts/apiKey" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const runtimeConfig = {
      tts: {
        enabled: true,
        provider: "mock",
        providers: {
          mock: {
            apiKey: "test-key",
          },
        },
      },
    } as unknown as OpenClawConfig;
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        isConfigured: ({ providerConfig }) => providerConfig.apiKey === "test-key",
        resolveConfig: ({ rawConfig }) => {
          const providers = rawConfig.providers as TtsConfig["providers"];
          return providers?.mock ?? {};
        },
      }),
    ]);
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const result = await synthesizeSpeech({
      text: "Runtime snapshot TTS SecretRef",
      cfg: sourceConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(synthesizeMock).toHaveBeenCalled();
    const request = requireFirstSynthesisRequest("runtime snapshot synthesis request");
    expect(request.cfg).toBe(runtimeConfig);
    const providerConfig = requireRecord(request.providerConfig, "provider config");
    expect(providerConfig.apiKey).toBe("test-key");
  });

  it("normalizes non-streaming synthesis text before calling the provider", async () => {
    const result = await synthesizeSpeech({
      text: "## Update\n\nRead the [guide](https://example.com/guide)!!!!!",
      cfg: createTtsConfig("openclaw-speech-core-talk-markdown-test"),
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    const request = requireFirstSynthesisRequest("normalized talk synthesis request");
    expect(request.text).toBe("Update\n\nRead the guide!");
  });

  it("speaks stripped code through the explicit textToSpeech conversion path", async () => {
    let mediaDir: string | undefined;
    try {
      const result = await textToSpeech({
        text: "```ts\nconst answer = 42;\n```",
        cfg: createTtsConfig("openclaw-speech-core-code-convert-test"),
      });

      expect(result.success).toBe(true);
      const request = requireFirstSynthesisRequest("explicit code conversion request");
      expect(request.text).toBe("const answer = 42;");
      mediaDir = result.audioPath ? path.dirname(result.audioPath) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it("returns a normal TTS failure when audio persistence rejects", async () => {
    const result = await textToSpeechCore(
      {
        text: "Store this synthesized reply.",
        cfg: createTtsConfig("openclaw-speech-core-persistence-failure-test"),
      },
      async () => {
        throw new Error("Media exceeds configured limit");
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: "TTS audio persistence failed",
      provider: "mock",
    });
  });

  afterEach(resetTtsRuntime);

  it("tells generic TTS guidance to defer to MEMORY voice-delivery instructions", () => {
    const hint = buildTtsSystemPromptHint(createTtsConfig("openclaw-speech-core-tts-hint-test"));

    expect(hint).toContain("Voice (TTS) is enabled.");
    expect(hint).toContain(
      "If workspace context (especially MEMORY.md) tells you not to use [[tts:...]] or to use a local/non-tagged voice workflow, follow that workspace instruction instead.",
    );
    expect(hint).toContain(
      "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
    );
  });

  it("prepares deep-merged surface config and directive inputs", async () => {
    const cfg = mockConfig({ model: "base-model", voiceSettings: { stability: 0.4 } });
    cfg.tts!.modelOverrides = { allowProvider: false };

    const prepared = await prepareTtsRequest({
      cfg,
      override: {
        modelOverrides: { allowProvider: true },
        providers: {
          mock: { voice: "surface-voice", voiceSettings: { speed: 1.1 } },
        },
      },
      text: "Hello [[tts:text]]Speak this instead[[/tts:text]] caller",
    });

    expect(prepared.cfg).not.toBe(cfg);
    expect(prepared.cfg.tts?.providers?.mock).toEqual({
      model: "base-model",
      voice: "surface-voice",
      voiceSettings: { stability: 0.4, speed: 1.1 },
    });
    expect(prepared.cfg.tts?.modelOverrides?.allowProvider).toBe(true);
    expect(prepared.directives).toEqual({
      cleanedText: "Hello  caller",
      hasDirective: true,
      overrides: { ttsText: "Speak this instead" },
      ttsText: "Speak this instead",
      warnings: [],
    });
    expect(cfg.tts?.providers?.mock).toEqual({
      model: "base-model",
      voiceSettings: { stability: 0.4 },
    });
  });

  it("sanitizes blocked override keys while preparing TTS config", async () => {
    const prepared = await prepareTtsRequest({
      cfg: mockConfig({ model: "base-model" }),
      override: JSON.parse(
        '{"__proto__":{"polluted":"top"},"providers":{"mock":{"voice":"safe","__proto__":{"polluted":"nested"}}}}',
      ) as TtsConfig,
      text: "[[tts:text]]Speak this instead[[/tts:text]]",
    });

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(prepared.cfg.tts).not.toHaveProperty("polluted");
    expect(prepared.cfg.tts?.providers?.mock).toEqual({
      model: "base-model",
      voice: "safe",
    });
    expect(prepared.directives).toMatchObject({ cleanedText: "", ttsText: "Speak this instead" });
  });

  it("skips preference preparation for explicit providers and empty overrides", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        aliases: ["mock-alias"],
        resolveTalkOverrides: ({ params }) => ({ voice: params.voiceId }),
      }),
    ]);
    const cfg = { tts: { provider: "mock", prefsPath: prefsPathFor("unused-explicit-overrides") } };
    const preparePreferences = vi.spyOn(ttsSettings, "resolveTtsPrefsPathAsync");
    try {
      await expect(
        resolveExplicitTtsOverridesAsync({ cfg, modelId: " ", voiceId: " " }),
      ).resolves.toEqual({});
      await expect(
        resolveExplicitTtsOverridesAsync({
          cfg,
          provider: "  MOCK-ALIAS  ",
          voiceId: " voice-id ",
        }),
      ).resolves.toEqual({
        provider: "mock",
        providerOverrides: { mock: { voice: "voice-id" } },
      });
      await expect(
        resolveExplicitTtsOverridesAsync({ cfg, provider: " UNKNOWN " }),
      ).resolves.toEqual({
        provider: "unknown",
      });
      await expect(
        resolveExplicitTtsOverridesAsync({ cfg, provider: "unknown", voiceId: "voice-id" }),
      ).rejects.toThrow("speech provider unknown is not registered");
      expect(preparePreferences).not.toHaveBeenCalled();
    } finally {
      preparePreferences.mockRestore();
    }
  });

  it("prepares fallback preferences once and reads their current provider after preparation", async () => {
    const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), "openclaw-explicit-overrides-"));
    const prefsPath = path.join(dir, "tts.json");
    const cfg = { tts: { provider: "previous", prefsPath } };
    installSpeechProviders([
      createMockSpeechProvider("previous"),
      createMockSpeechProvider("mock", {
        resolveTalkOverrides: ({ params }) => ({ voice: params.voiceId }),
      }),
    ]);
    writeFileSync(prefsPath, JSON.stringify({ tts: { provider: "previous" } }));
    const resolvePrefsPath = ttsSettings.resolveTtsPrefsPathAsync;
    const preparePreferences = vi
      .spyOn(ttsSettings, "resolveTtsPrefsPathAsync")
      .mockImplementation(async (...args) => {
        const preparedPath = await resolvePrefsPath(...args);
        writeFileSync(prefsPath, JSON.stringify({ tts: { provider: "mock" } }));
        return preparedPath;
      });
    try {
      await expect(resolveExplicitTtsOverridesAsync({ cfg, voiceId: "voice-id" })).resolves.toEqual(
        {
          provider: "mock",
          providerOverrides: { mock: { voice: "voice-id" } },
        },
      );
      expect(preparePreferences).toHaveBeenCalledOnce();
    } finally {
      preparePreferences.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pre-transcodes synthesized mp3 to opus-in-CAF when the host can satisfy preferAudioFileFormat", async () => {
    transcodeAudioBufferMock.mockResolvedValueOnce({
      ok: true,
      buffer: Buffer.from("transcoded-caf"),
    });
    await expectVoiceMemo("caf");
    expect(transcodeAudioBufferMock).toHaveBeenCalledOnce();
    const transcodeRequest = requireRecord(
      requireFirstCallParam(transcodeAudioBufferMock.mock.calls as unknown[][], "transcode"),
      "transcode request",
    );
    expect(transcodeRequest).toMatchObject({ sourceExtension: "mp3", targetExtension: "caf" });
  });

  it("falls back to the original mp3 buffer when the host transcoder fails", async () => {
    transcodeAudioBufferMock.mockResolvedValueOnce({
      ok: false,
      reason: "transcoder-failed",
      detail: "exit-1",
    });
    // The original mp3 still satisfies the channel's voice-memo formats.
    await expectVoiceMemo("mp3");
  });

  it("uses the active runtime snapshot when source config still contains TTS SecretRefs", async () => {
    const sourceConfig = mockConfig({
      apiKey: { source: "exec", provider: "mockexec", id: "minimax/tts/apiKey" },
    });
    const runtimeConfig = mockConfig({ apiKey: "test-key" });
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        isConfigured: ({ providerConfig }) => providerConfig.apiKey === "test-key",
        resolveConfig: ({ rawConfig }) => {
          const providers = rawConfig.providers as Record<string, { apiKey?: unknown }> | undefined;
          return providers?.mock ?? {};
        },
      }),
    ]);
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const result = await synthesizeSpeech({
      text: "Runtime snapshot TTS SecretRef",
      cfg: sourceConfig,
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(synthesizeMock).toHaveBeenCalled();
    const request = requireFirstSynthesisRequest("runtime snapshot synthesis request");
    expect(request.cfg).toBe(runtimeConfig);
    const providerConfig = requireRecord(request.providerConfig, "provider config");
    expect(providerConfig.apiKey).toBe("test-key");
  });

  it("resolves voice listing aliases with the configured timeout", async () => {
    const listVoicesMock = vi.fn(async (_request: SpeechListVoicesRequest) => []);
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        aliases: ["mock-alias"],
        defaultTimeoutMs: 60_000,
        listVoices: listVoicesMock,
      }),
    ]);

    await listSpeechVoices({
      provider: "  MOCK-ALIAS  ",
      cfg: { tts: { enabled: true, provider: "mock", timeoutMs: 45_000 } },
    });

    expect(listVoicesMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 45_000 }));
  });

  it("holds the speech provider local-service lease while listing voices", async () => {
    const release = vi.fn();
    acquireSpeechProviderLocalServiceMock.mockResolvedValueOnce({ release });
    const listVoicesMock = vi.fn(async (_request: SpeechListVoicesRequest) => {
      expect(release).not.toHaveBeenCalled();
      return [];
    });
    installSpeechProviders([createMockSpeechProvider("mock", { listVoices: listVoicesMock })]);
    const providerConfig = {
      baseUrl: "http://127.0.0.1:8020/v1",
      localService: {
        command: "/srv/openclaw/workers/tts",
        healthUrl: "http://127.0.0.1:8020/ready",
      },
    };

    await listSpeechVoices({
      provider: "mock",
      cfg: {
        tts: {
          enabled: true,
          provider: "mock",
          providers: { mock: providerConfig },
        },
      } as OpenClawConfig,
    });

    expect(acquireSpeechProviderLocalServiceMock).toHaveBeenCalledWith({
      providerId: "mock",
      providerConfig,
    });
    expect(listVoicesMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["provider default", 600_000, undefined, 600_000],
    ["capped provider default", Number.MAX_SAFE_INTEGER, undefined, MAX_TIMER_TIMEOUT_MS],
    ["nonpositive provider default", 0, undefined, 30_000],
    ["explicit configuration wins", 600_000, 45_000, 45_000],
  ] as const)(
    "resolves synthesis timeout: %s",
    async (_name, defaultTimeoutMs, timeoutMs, expected) => {
      installSpeechProviders([createMockSpeechProvider("mock", { defaultTimeoutMs })]);
      const result = await synthesizeSpeech({
        text: "Use the resolved timeout.",
        cfg: { tts: { enabled: true, provider: "mock", timeoutMs } },
        disableFallback: true,
      });

      expect(result.success).toBe(true);
      expect(requireFirstSynthesisRequest("timeout synthesis request").timeoutMs).toBe(expected);
    },
  );
});
