import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { discoverConfigSecretTargetsByIds } from "../secrets/target-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { MessageSpeechAdmission } from "./message-speech-admission.js";
import {
  clearRuntimeConfigSnapshot,
  createMockSpeechProvider,
  getTtsPersona,
  getTtsProvider,
  installSpeechProviders,
  isTtsProviderConfigured,
  maybeApplyTtsToPayload,
  maybeApplyTtsToPayloadCore,
  prepareTextToSpeechTelephony,
  prepareSynthesisMock,
  acquireSpeechProviderLocalServiceMock,
  requireAttempt,
  requireFirstCallParam,
  requireFirstSynthesisRequest,
  requireRecord,
  resolveTtsConfig,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  synthesizeSpeech,
  streamTextToSpeechTelephony,
  textToSpeechStream,
  textToSpeechTelephony,
  transcodeAudioBufferMock,
  type OpenClawConfig,
  type ReplyPayload,
  type SpeechTelephonySynthesisRequest,
  type SpeechSynthesisRequest,
  type TtsConfig,
} from "./tts-runtime.test-support.js";

function personaConfig(
  persona: NonNullable<TtsConfig["personas"]>[string],
  overrides: TtsConfig = {},
): OpenClawConfig {
  return {
    tts: {
      enabled: true,
      provider: "mock",
      persona: "alfred",
      personas: { alfred: persona },
      ...overrides,
    },
  };
}

describe("TTS runtime persona behavior", () => {
  afterEach(() => {
    setTtsMachinePrefsPathResolver();
    clearRuntimeConfigSnapshot();
    clearSecretsRuntimeSnapshot();
    delete (Object.prototype as Record<string, unknown>).polluted;
    synthesizeMock.mockClear();
    prepareSynthesisMock.mockClear();
    acquireSpeechProviderLocalServiceMock.mockClear();
    transcodeAudioBufferMock.mockClear();
    installSpeechProviders([createMockSpeechProvider()]);
  });

  it("prepares and retains the agent-scoped telephony provider without synthesizing", async () => {
    const release = vi.fn();
    acquireSpeechProviderLocalServiceMock.mockResolvedValueOnce({ release });
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        synthesizeTelephony: vi.fn(async () => ({
          audioBuffer: Buffer.from("unused"),
          outputFormat: "pcm",
          sampleRate: 24_000,
        })),
      }),
    ]);
    const signal = new AbortController().signal;

    const result = await prepareTextToSpeechTelephony({
      cfg: {
        tts: {
          enabled: true,
          provider: "mock",
          personas: {
            narrator: { providers: { mock: { voice: "agent-voice" } } },
          },
        },
        agents: { entries: { reader: { tts: { persona: "narrator" } } } },
      },
      agentId: "reader",
      channelId: "matrix",
      signal,
    });

    expect(result).toMatchObject({
      success: true,
      persona: "narrator",
      provider: "mock",
      providerVoice: "agent-voice",
    });
    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(prepareSynthesisMock).not.toHaveBeenCalled();
    expect(acquireSpeechProviderLocalServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "mock", signal }),
    );
    await result.release?.();
    expect(release).toHaveBeenCalledOnce();
  });

  it("streams ordered telephony audio while retaining the local provider lease", async () => {
    const releaseLease = vi.fn();
    const releaseProvider = vi.fn(async () => undefined);
    acquireSpeechProviderLocalServiceMock.mockResolvedValueOnce({ release: releaseLease });
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        streamSynthesizeTelephony: vi.fn(async () => ({
          audioStream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Uint8Array.from([1, 0]));
              controller.enqueue(Uint8Array.from([2, 0]));
              controller.close();
            },
          }),
          outputFormat: "pcm",
          sampleRate: 16_000,
          release: releaseProvider,
        })),
      }),
    ]);

    const result = await streamTextToSpeechTelephony({
      text: "Frühe Ausgabe.",
      cfg: { tts: { enabled: true, provider: "mock" } },
    });
    expect(result).toMatchObject({ success: true, sampleRate: 16_000, outputFormat: "pcm" });
    const chunks: Buffer[] = [];
    if (!result.audioStream) {
      throw new Error("expected telephony audio stream");
    }
    for await (const chunk of result.audioStream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(chunks).toEqual([Buffer.from([1, 0]), Buffer.from([2, 0])]);
    expect(releaseLease).not.toHaveBeenCalled();
    await result.release?.();
    expect(releaseProvider).toHaveBeenCalledOnce();
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it("selects persona preferred provider before config fallback", () => {
    const cfg = personaConfig(
      {
        label: "Alfred",
        provider: "mock",
        providers: { mock: { voice: "Algieba" } },
      },
      { provider: "other" },
    );
    const config = resolveTtsConfig(cfg);
    const prefsPath = "/tmp/openclaw-speech-core-persona-provider.json";

    expect(getTtsPersona(config, prefsPath)?.id).toBe("alfred");
    expect(getTtsProvider(config, prefsPath)).toBe("mock");
  });

  it("treats provider configuration errors as unconfigured", () => {
    installSpeechProviders([
      createMockSpeechProvider("broken", {
        resolveConfig: () => {
          throw new Error("invalid provider URL");
        },
      }),
    ]);
    const prefsPath = "/tmp/openclaw-speech-core-invalid-provider.json";
    setTtsMachinePrefsPathResolver(() => prefsPath);
    const cfg = {
      tts: {
        providers: { broken: {} },
      },
    } as OpenClawConfig;
    const config = resolveTtsConfig(cfg);

    expect(isTtsProviderConfigured(config, "broken", cfg)).toBe(false);
    expect(getTtsProvider(config, prefsPath)).toBe("");
  });

  it("merges active persona provider binding into synthesis config", async () => {
    setTtsMachinePrefsPathResolver(() => "/tmp/openclaw-speech-core-persona-merge.json");
    const cfg = personaConfig(
      {
        provider: "mock",
        providers: { mock: { voice: "persona-voice", style: "dry" } },
      },
      { providers: { mock: { model: "base-model", voice: "base-voice" } } },
    );

    const payload: ReplyPayload = {
      text: "This reply should use persona-specific provider configuration.",
    };

    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload,
        cfg,
        channel: "slack",
        kind: "final",
      });

      expect(synthesizeMock).toHaveBeenCalled();
      const request = requireFirstSynthesisRequest("persona synthesis request");
      const providerConfig = requireRecord(request.providerConfig, "persona provider config");
      expect(providerConfig.model).toBe("base-model");
      expect(providerConfig.voice).toBe("persona-voice");
      expect(providerConfig.style).toBe("dry");
      expect(result.mediaUrl).toMatch(/voice---[a-f0-9-]+\.ogg$/);

      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });

  it.each(["base", "global", "agent"] as const)(
    "materializes %s TTS SecretRefs before selected-persona synthesis",
    async (scope) => {
      await withOpenClawTestState({ label: "tts-persona-secrets" }, async (state) => {
        const personaRef = {
          source: "env",
          provider: "default",
          id: "TEST_TTS_PERSONA_KEY",
        } as const;
        const expectedKey = scope === "base" ? "base-fixture-key" : "persona-fixture-key";
        const personas = {
          "reader.uk": {
            provider: "mock",
            providers: {
              mock: {
                voice: "persona-voice",
                ...(scope === "base" ? {} : { apiKey: personaRef }),
              },
            },
          },
        };
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          tts: {
            auto: "off",
            provider: "mock",
            persona: "reader.uk",
            providers: {
              mock: {
                apiKey: { source: "env", provider: "default", id: "TEST_TTS_BASE_KEY" },
                model: "base-model",
              },
            },
            ...(scope === "agent" ? {} : { personas }),
          },
          ...(scope === "agent" ? { agents: { entries: { reader: { tts: { personas } } } } } : {}),
        };
        installSpeechProviders([
          createMockSpeechProvider("mock", {
            isConfigured: ({ providerConfig }) => providerConfig.apiKey === expectedKey,
          }),
        ]);
        const snapshot = await prepareSecretsRuntimeSnapshot({
          config: cfg,
          env: {
            TEST_TTS_BASE_KEY: "base-fixture-key",
            TEST_TTS_PERSONA_KEY: "persona-fixture-key",
          },
          agentDirs: [state.agentDir()],
          includeAuthStoreRefs: false,
          manifestRegistry: { plugins: [] },
        });
        const result = await synthesizeSpeech({
          text: "Read this fixture.",
          cfg: snapshot.config,
          agentId: scope === "agent" ? "reader" : undefined,
          prefsPath: state.path("tts-prefs.json"),
          disableFallback: true,
        });
        expect(result).toMatchObject({ success: true, audioBuffer: Buffer.from("voice") });
        expect(
          requireFirstSynthesisRequest("resolved persona synthesis").providerConfig,
        ).toMatchObject({
          apiKey: expectedKey,
          model: "base-model",
          voice: "persona-voice",
        });
        expect(snapshot.sourceConfig).toEqual(cfg);
        expect(snapshot.warnings).toEqual([]);
        const prefix = scope === "agent" ? "agents.entries.*.tts" : "tts";
        const targetId =
          scope === "base" ? "tts.providers.*.apiKey" : `${prefix}.personas.*.providers.*.apiKey`;
        const targets = discoverConfigSecretTargetsByIds(cfg, new Set([targetId]));
        expect(targets).toMatchObject([
          {
            providerId: "mock",
            path:
              scope === "base"
                ? "tts.providers.mock.apiKey"
                : `${scope === "agent" ? "agents.entries.reader.tts" : "tts"}.personas["reader.uk"].providers.mock.apiKey`,
          },
        ]);
      });
    },
  );

  it("keeps a missing persona SecretRef unavailable before any synthesis request", async () => {
    await withOpenClawTestState({ label: "tts-persona-unavailable" }, async (state) => {
      await import("./tts.js");
      const ref = {
        source: "env",
        provider: "default",
        id: "TEST_TTS_MISSING_PERSONA_KEY",
      } as const;
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        tts: {
          provider: "mock",
          persona: "reader",
          providers: { mock: { apiKey: "other-fixture-key" } },
          personas: { reader: { providers: { mock: { apiKey: ref } } } },
        },
      };
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: cfg,
        env: {},
        agentDirs: [state.agentDir()],
        includeAuthStoreRefs: false,
        manifestRegistry: { plugins: [] },
        allowUnavailableSecretOwners: true,
      });
      activateSecretsRuntimeSnapshot(snapshot);
      await expect(
        synthesizeSpeech({
          text: "Do not use another credential.",
          cfg: snapshot.config,
          prefsPath: state.path("tts-prefs.json"),
          disableFallback: true,
        }),
      ).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE", ownerId: "tts" });
      expect(snapshot.config.tts?.personas?.reader?.providers?.mock?.apiKey).toEqual(ref);
      expect(synthesizeMock).not.toHaveBeenCalled();
    });
  });

  it("does not mark skipped unregistered providers as missing persona bindings", async () => {
    const result = await synthesizeSpeech({
      text: "Use fallback provider.",
      cfg: personaConfig(
        { providers: { missing: { voice: "configured-but-unregistered" } } },
        { provider: "missing" },
      ),
    });

    expect(result.success).toBe(true);
    const attempt = requireAttempt(result.attempts, 0);
    expect(attempt.provider).toBe("missing");
    expect(attempt.outcome).toBe("skipped");
    expect(attempt.reasonCode).toBe("no_provider_registered");
    expect(attempt.persona).toBe("alfred");
    expect(attempt).not.toHaveProperty("personaBinding");
  });

  it("does not mark skipped telephony providers as missing persona bindings", async () => {
    const result = await textToSpeechTelephony({
      text: "Use telephony provider.",
      cfg: personaConfig({ providers: { mock: { voice: "persona-voice" } } }),
    });

    expect(result.success).toBe(false);
    const attempt = requireAttempt(result.attempts, 0);
    expect(attempt.provider).toBe("mock");
    expect(attempt.outcome).toBe("skipped");
    expect(attempt.reasonCode).toBe("unsupported_for_telephony");
    expect(attempt.persona).toBe("alfred");
    expect(attempt).not.toHaveProperty("personaBinding");
  });

  it("passes directive overrides to telephony synthesis providers", async () => {
    const synthesizeTelephonyMock = vi.fn(async (_request: SpeechTelephonySynthesisRequest) => ({
      audioBuffer: Buffer.from("voice"),
      outputFormat: "pcm",
      sampleRate: 24_000,
    }));
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        synthesizeTelephony: synthesizeTelephonyMock,
      }),
    ]);

    const text = "## Keep [telephony Markdown](https://example.com) raw!!!!!";
    const result = await textToSpeechTelephony({
      text,
      cfg: {
        tts: {
          enabled: true,
          provider: "mock",
          providers: {
            mock: {
              modelId: "telephony-model",
              voiceId: "default-voice",
            },
          },
        },
      },
      overrides: {
        providerOverrides: {
          mock: {
            speakerVoice: "directed-voice",
            speed: 1.5,
          },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.providerModel).toBe("telephony-model");
    expect(result.providerVoice).toBe("directed-voice");
    expect(synthesizeTelephonyMock).toHaveBeenCalledOnce();
    const telephonyRequest = requireRecord(
      requireFirstCallParam(synthesizeTelephonyMock.mock.calls, "telephony synthesis"),
      "telephony synthesis request",
    );
    expect(telephonyRequest.providerOverrides).toEqual({
      speakerVoice: "directed-voice",
      speed: 1.5,
    });
    expect(telephonyRequest.text).toBe(text);
    expect(telephonyRequest).not.toHaveProperty("target");
  });

  it.each(["buffered", "telephony", "stream", "telephony-stream"] as const)(
    "passes structured expression through the native %s synthesis owner without changing plain text",
    async (mode) => {
      const expression = {
        emotion: "joyful",
        parts: [{ text: "Hello " }, { event: "laugh" }, { text: "there.", emphasis: true }],
      };
      const telephony = vi.fn(async (_request: SpeechTelephonySynthesisRequest) => ({
        audioBuffer: Buffer.from("voice"),
        outputFormat: "pcm",
        sampleRate: 24_000,
      }));
      const streamResult = () => ({
        audioStream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        outputFormat: "pcm",
        sampleRate: 24_000,
        fileExtension: ".pcm",
        voiceCompatible: true,
      });
      const stream = vi.fn(async (_request: SpeechSynthesisRequest) => streamResult());
      const telephonyStream = vi.fn(async (_request: SpeechTelephonySynthesisRequest) =>
        streamResult(),
      );
      installSpeechProviders([
        createMockSpeechProvider("mock", {
          getExpressionCapabilities: ({ providerConfig }) =>
            providerConfig.model === "expressive-model"
              ? { emotions: ["joyful"], vocalEvents: ["laugh"], emphasis: true, whisper: false }
              : undefined,
          synthesizeTelephony: telephony,
          streamSynthesize: stream,
          streamSynthesizeTelephony: telephonyStream,
        }),
      ]);
      const cfg: OpenClawConfig = {
        tts: { provider: "mock", providers: { mock: { model: "expressive-model" } } },
        talk: {
          speech: {
            agentProfiles: {
              reader: {
                expression: { channels: { matrix: { targets: ["voice-note", "telephony"] } } },
              },
            },
          },
        },
      };
      const common = { text: "Hello there.", cfg, agentId: "reader", overrides: { expression } };
      const dispatch = (agentId = "reader") => {
        switch (mode) {
          case "buffered":
            return synthesizeSpeech({ ...common, agentId, channel: "matrix" });
          case "telephony":
            return textToSpeechTelephony({ ...common, agentId, channelId: "matrix" });
          case "stream":
            return textToSpeechStream({ ...common, agentId, channel: "matrix" });
          case "telephony-stream":
            return streamTextToSpeechTelephony({ ...common, agentId, channelId: "matrix" });
        }
        throw new Error("Unexpected synthesis test mode");
      };
      const result = await dispatch();
      expect(result.success).toBe(true);
      const request =
        mode === "buffered"
          ? requireFirstSynthesisRequest("expression synthesis")
          : requireRecord(
              requireFirstCallParam(
                (mode === "telephony" ? telephony : mode === "stream" ? stream : telephonyStream)
                  .mock.calls,
                "expression stream/telephony",
              ),
              "expression request",
            );
      expect(request.text).toBe("Hello there.");
      expect(request.expression).toEqual(expression);
      if ("release" in result) {
        await result.release?.();
      }

      acquireSpeechProviderLocalServiceMock.mockClear();
      synthesizeMock.mockClear();
      telephony.mockClear();
      stream.mockClear();
      telephonyStream.mockClear();
      const denied = await dispatch("other");
      expect(denied.success).toBe(false);
      expect(acquireSpeechProviderLocalServiceMock).not.toHaveBeenCalled();
      expect(synthesizeMock).not.toHaveBeenCalled();
      expect(telephony).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
      expect(telephonyStream).not.toHaveBeenCalled();

      const unsupportedCfg: OpenClawConfig = {
        ...cfg,
        tts: { provider: "mock", providers: { mock: { model: "plain-model" } } },
      };
      const unsupported = await synthesizeSpeech({
        ...common,
        cfg: unsupportedCfg,
        channel: "matrix",
      });
      expect(unsupported.success).toBe(false);
      expect(acquireSpeechProviderLocalServiceMock).not.toHaveBeenCalled();
    },
  );

  it.each(["override-model", "prepared-model", "prepared-text"] as const)(
    "refuses expression when %s invalidates its admitted model or projection",
    async (mode) => {
      const release = vi.fn();
      if (mode !== "override-model") {
        acquireSpeechProviderLocalServiceMock.mockResolvedValueOnce({ release });
      }
      installSpeechProviders([
        createMockSpeechProvider("mock", {
          getExpressionCapabilities: ({ providerConfig, providerOverrides }) =>
            (providerOverrides?.modelId ?? providerConfig.model) === "expressive-model"
              ? { emotions: ["joyful"], vocalEvents: [], emphasis: false, whisper: false }
              : undefined,
          prepareSynthesis: vi.fn(async () =>
            mode === "prepared-model"
              ? { providerConfig: { model: "plain-model" } }
              : mode === "prepared-text"
                ? { text: "Changed." }
                : undefined,
          ),
        }),
      ]);
      const result = await synthesizeSpeech({
        text: "Hello.",
        cfg: {
          tts: { provider: "mock", providers: { mock: { model: "expressive-model" } } },
          talk: {
            speech: {
              agentProfiles: {
                reader: { expression: { channels: { matrix: { targets: ["voice-note"] } } } },
              },
            },
          },
        },
        agentId: "reader",
        channel: "matrix",
        overrides: {
          expression: { emotion: "joyful", parts: [{ text: "Hello." }] },
          ...(mode === "override-model"
            ? { providerOverrides: { mock: { modelId: "plain-model" } } }
            : {}),
        },
      });
      expect(result.success).toBe(false);
      expect(synthesizeMock).not.toHaveBeenCalled();
      if (mode === "override-model") {
        expect(acquireSpeechProviderLocalServiceMock).not.toHaveBeenCalled();
      } else {
        expect(release).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["provider", "model", "voice", "worker"] as const)(
    "does not synthesize after the pre-model admitted speech %s changes",
    async (changed) => {
      installSpeechProviders([
        createMockSpeechProvider("mock", {
          getExpressionCapabilities: () => ({
            emotions: ["joyful"],
            vocalEvents: [],
            emphasis: false,
            whisper: false,
          }),
        }),
      ]);
      const signal = new AbortController().signal;
      if (changed === "worker") {
        acquireSpeechProviderLocalServiceMock.mockResolvedValueOnce({
          release: vi.fn(),
          admission: { generation: "worker-current", signal },
        });
      }
      const result = await synthesizeSpeech({
        text: "Hello.",
        agentId: "example",
        channel: "matrix",
        cfg: {
          tts: {
            provider: "mock",
            providers: { mock: { model: "expressive-model", voice: "voice-example" } },
          },
          talk: {
            speech: {
              agentProfiles: {
                example: { expression: { channels: { matrix: { targets: ["voice-note"] } } } },
              },
            },
          },
        },
        overrides: { expression: { emotion: "joyful", parts: [{ text: "Hello." }] } },
        expectedSpeechSelection: {
          provider: changed === "provider" ? "previous-provider" : "mock",
          model: changed === "model" ? "previous-model" : "expressive-model",
          voice: changed === "voice" ? "previous-voice" : "voice-example",
        },
        localServiceAdmission:
          changed === "worker" ? { generation: "worker-previous", signal } : undefined,
        disableFallback: true,
      });
      expect(result.success).toBe(false);
      expect(synthesizeMock).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "retains native allowVoice=%s policy on an admitted final voice-note wire payload",
    async (allowVoice) => {
      await withOpenClawTestState({ label: "expression-wire-voice" }, async (state) => {
        setTtsMachinePrefsPathResolver(() => state.path("tts-prefs.json"));
        const provider = createMockSpeechProvider("mock", {
          getExpressionCapabilities: () => ({
            emotions: ["joyful"],
            vocalEvents: [],
            emphasis: false,
            whisper: false,
          }),
        });
        installSpeechProviders([provider]);
        const cfg: OpenClawConfig = {
          tts: {
            auto: "inbound",
            provider: "mock",
            modelOverrides: { allowVoice },
            providers: { mock: { model: "expressive-model", voice: "default-voice" } },
          },
          talk: {
            speech: {
              agentProfiles: {
                example: { expression: { channels: { matrix: { targets: ["voice-note"] } } } },
              },
            },
          },
        };
        const facts = {
          tagged: true as const,
          text: "Hello.",
          expression: { emotion: "joyful", parts: [{ text: "Hello." }] },
          directives: [{ values: { speakervoice: "directed-voice" } }],
        };
        const admission: MessageSpeechAdmission = {
          runId: "run-example",
          sessionId: "session-example",
          agentId: "example",
          route: { channel: "matrix", to: "room:example" },
          assertCurrent: vi.fn(),
          prefsPath: state.path("tts-prefs.json"),
          preparedTtsPreferences: {},
          sessionAuto: "inbound",
          expectedSpeechSelection: {
            provider: "mock",
            model: "expressive-model",
            voice: "default-voice",
          },
        };
        const persist = vi.fn(async () => "fixture-voice.ogg");
        const result = await maybeApplyTtsToPayloadCore(
          {
            payload: setReplyPayloadMetadata({ text: "Hello." }, { ttsExplicit: true, tts: facts }),
            cfg,
            channel: "matrix",
            agentId: "example",
            kind: "final",
            inboundAudio: true,
            preparedTtsPreferences: admission.preparedTtsPreferences,
            messageSpeechAdmission: admission,
          },
          persist,
        );
        expect(result.text).toBe("Hello.");
        expect(result.audioAsVoice).toBe(true);
        expect(result.mediaUrl).toBe("fixture-voice.ogg");
        expect(persist).toHaveBeenCalledOnce();
        const request = requireFirstSynthesisRequest("native expression voice override");
        expect(request.target).toBe("voice-note");
        expect(request.providerOverrides).toEqual(
          allowVoice
            ? {
                speakerVoice: "directed-voice",
                voice: "directed-voice",
                voiceName: "directed-voice",
              }
            : undefined,
        );
        expect(JSON.stringify(result)).not.toContain("expectedSpeechSelection");
      });
    },
  );

  it.each(["always", "inbound"] as const)(
    "speaks successive plain automatic replies when voice-note expression is enabled (%s)",
    async (auto) => {
      await withOpenClawTestState({ label: "automatic-expression-final" }, async (state) => {
        setTtsMachinePrefsPathResolver(() => state.path("tts-prefs.json"));
        const payload = { text: "Neutral automatic final answer." };
        const cfg: OpenClawConfig = {
          tts: {
            auto,
            provider: "mock",
            providers: { mock: { model: "expressive-model" } },
          },
          talk: {
            speech: {
              agentProfiles: {
                example: { expression: { channels: { matrix: { targets: ["voice-note"] } } } },
              },
            },
          },
        };
        const persist = vi.fn(async () => "fixture-voice.ogg");
        const assertCurrent = vi.fn();
        const admission: MessageSpeechAdmission = {
          runId: "plain-run",
          sessionId: "plain-session",
          agentId: "example",
          route: { channel: "matrix", to: "room:example" },
          assertCurrent,
          prefsPath: state.path("tts-prefs.json"),
          preparedTtsPreferences: {},
          sessionAuto: auto,
          expectedSpeechSelection: { provider: "mock", model: "expressive-model" },
        };
        for (const text of [payload.text, "A second plain answer after the first voice note."]) {
          const result = await maybeApplyTtsToPayloadCore(
            {
              payload: { text },
              cfg,
              channel: "matrix",
              agentId: "example",
              kind: "final",
              inboundAudio: true,
              preparedTtsPreferences: {},
              messageSpeechAdmission: admission,
            },
            persist,
          );
          expect(result).toMatchObject({ text, mediaUrl: "fixture-voice.ogg", audioAsVoice: true });
        }
        expect(synthesizeMock).toHaveBeenCalledTimes(2);
        expect(acquireSpeechProviderLocalServiceMock).toHaveBeenCalledTimes(2);
        expect(persist).toHaveBeenCalledTimes(2);
        expect(synthesizeMock.mock.calls.every(([request]) => !request.expression)).toBe(true);
        expect(assertCurrent).toHaveBeenCalled();
        for (const cold of [
          { cfg: { ...cfg, tts: { ...cfg.tts, auto: "off" as const } }, inboundAudio: true },
          { cfg: { ...cfg, tts: { ...cfg.tts, auto: "tagged" as const } }, inboundAudio: true },
          { cfg: { ...cfg, tts: { ...cfg.tts, auto: "inbound" as const } }, inboundAudio: false },
        ]) {
          expect(
            await maybeApplyTtsToPayload({
              payload,
              ...cold,
              channel: "matrix",
              agentId: "example",
              kind: "final",
              preparedTtsPreferences: {},
            }),
          ).toBe(payload);
        }
        expect(synthesizeMock).toHaveBeenCalledTimes(2);
        expect(acquireSpeechProviderLocalServiceMock).toHaveBeenCalledTimes(2);
      });
    },
  );

  it("rejects overlong structured speech before summarizing or truncating its spans", async () => {
    await withOpenClawTestState({ label: "expression-length" }, async (state) => {
      setTtsMachinePrefsPathResolver(() => state.path("tts-prefs.json"));
      const text = "x".repeat(2_000);
      const payload = setReplyPayloadMetadata(
        { text: "Complete visible answer." },
        {
          ttsExplicit: true,
          tts: { tagged: true, text, expression: { parts: [{ text }] } },
        },
      );
      await expect(
        maybeApplyTtsToPayload({
          payload,
          cfg: { tts: { provider: "mock" } },
          channel: "matrix",
          agentId: "reader",
        }),
      ).rejects.toThrow("Structured speech expression exceeds the spoken text limit");
      expect(synthesizeMock).not.toHaveBeenCalled();
      expect(acquireSpeechProviderLocalServiceMock).not.toHaveBeenCalled();
    });
  });

  it("applies agent-scoped persona bindings to telephony synthesis", async () => {
    const synthesizeTelephonyMock = vi.fn(async (_request: SpeechTelephonySynthesisRequest) => ({
      audioBuffer: Buffer.from("voice"),
      outputFormat: "pcm",
      sampleRate: 24_000,
    }));
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        synthesizeTelephony: synthesizeTelephonyMock,
      }),
    ]);

    const result = await textToSpeechTelephony({
      text: "Use the agent's telephony voice.",
      agentId: "reader",
      channelId: "matrix",
      accountId: "personal",
      cfg: {
        tts: {
          enabled: true,
          provider: "mock",
          persona: "default",
          personas: {
            default: { providers: { mock: { voice: "default-voice" } } },
            narrator: { providers: { mock: { voice: "agent-voice" } } },
          },
        },
        agents: {
          entries: { reader: { tts: { persona: "narrator" } } },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.persona).toBe("narrator");
    expect(result.providerVoice).toBe("agent-voice");
    const telephonyRequest = requireRecord(
      requireFirstCallParam(synthesizeTelephonyMock.mock.calls, "agent telephony synthesis"),
      "agent telephony synthesis request",
    );
    expect(telephonyRequest.providerConfig).toEqual(
      expect.objectContaining({ voice: "agent-voice" }),
    );
  });

  it("uses provider defaults when fallback policy allows missing persona bindings", async () => {
    await synthesizeSpeech({
      text: "Use neutral provider defaults.",
      cfg: personaConfig({ fallbackPolicy: "provider-defaults" }),
    });

    expect(prepareSynthesisMock).toHaveBeenCalledOnce();
    const prepareContext = requireRecord(
      requireFirstCallParam(prepareSynthesisMock.mock.calls, "prepare synthesis"),
      "prepare synthesis context",
    );
    expect(prepareContext.persona).toBeUndefined();
    expect(prepareContext.personaProviderConfig).toBeUndefined();
  });

  it("preserves persona metadata by default when provider bindings are missing", async () => {
    await synthesizeSpeech({
      text: "Use persona prompt.",
      cfg: personaConfig({ label: "Alfred" }),
    });

    expect(prepareSynthesisMock).toHaveBeenCalledOnce();
    const prepareContext = requireRecord(
      requireFirstCallParam(prepareSynthesisMock.mock.calls, "prepare synthesis"),
      "prepare synthesis context",
    );
    const persona = requireRecord(prepareContext.persona, "prepare synthesis persona");
    expect(persona.id).toBe("alfred");
    expect(prepareContext.personaProviderConfig).toBeUndefined();
  });

  it("skips unbound providers under fail policy while allowing bound fallbacks", async () => {
    installSpeechProviders([
      createMockSpeechProvider("mock", { autoSelectOrder: 1 }),
      createMockSpeechProvider("fallback", { autoSelectOrder: 2 }),
    ]);

    const result = await synthesizeSpeech({
      text: "Use the first persona-bound provider.",
      cfg: personaConfig({
        fallbackPolicy: "fail",
        providers: { fallback: { voice: "fallback-voice" } },
      }),
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("fallback");
    expect(result.fallbackFrom).toBe("mock");
    const skippedAttempt = requireAttempt(result.attempts, 0);
    expect(skippedAttempt.provider).toBe("mock");
    expect(skippedAttempt.outcome).toBe("skipped");
    expect(skippedAttempt.reasonCode).toBe("not_configured");
    expect(skippedAttempt.persona).toBe("alfred");
    expect(skippedAttempt.personaBinding).toBe("missing");
    expect(skippedAttempt.error).toBe("mock: persona alfred has no provider binding");
    const successAttempt = requireAttempt(result.attempts, 1);
    expect(successAttempt.provider).toBe("fallback");
    expect(successAttempt.outcome).toBe("success");
    expect(successAttempt.persona).toBe("alfred");
    expect(successAttempt.personaBinding).toBe("applied");
  });
});

describe("TTS runtime per-agent config", () => {
  it("composes per-agent TTS overrides with active persona bindings", async () => {
    const cfg = {
      tts: {
        enabled: true,
        provider: "mock",
        providers: {
          mock: {
            model: "base-model",
            voice: "base-voice",
          },
        },
        persona: "alfred",
        personas: {
          alfred: {
            provider: "mock",
            providers: {
              mock: {
                voice: "alfred-voice",
              },
            },
          },
          jarvis: {
            provider: "mock",
            providers: {
              mock: {
                style: "jarvis-style",
              },
            },
          },
        },
      },
      agents: {
        entries: {
          reader: {
            tts: {
              persona: "jarvis",
              providers: {
                mock: {
                  voice: "agent-voice",
                },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload: { text: "This agent reply should use the composed persona config." },
        cfg,
        channel: "slack",
        kind: "final",
        agentId: "reader",
      });

      expect(synthesizeMock).toHaveBeenCalled();
      const request = requireFirstSynthesisRequest("agent persona synthesis request");
      const providerConfig = requireRecord(request.providerConfig, "agent persona provider config");
      expect(providerConfig.model).toBe("base-model");
      expect(providerConfig.voice).toBe("agent-voice");
      expect(providerConfig.style).toBe("jarvis-style");
      expect(result.mediaUrl).toMatch(/voice---[a-f0-9-]+\.ogg$/);
      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });
});
