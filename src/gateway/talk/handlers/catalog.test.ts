import "./handlers.test-support.js";
/** Tests for talk gateway methods that coordinate speech and audio providers. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RealtimeVoiceProviderResolveConfigContext } from "../../../talk/provider-types.js";
import { mocks, callTalkHandler, markTalkOwnerCold } from "./handlers.test-support.js";
import { expectRespondError, expectRespondOk, mockCallArg } from "./responses.test-support.js";

describe("talk.catalog handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSpeechProviders.mockReturnValue([]);
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([]);
    mocks.listRealtimeVoiceProviders.mockReturnValue([]);
    mocks.getResolvedSpeechProviderConfig.mockReturnValue({});
    mocks.resolveTtsConfig.mockReturnValue({ timeoutMs: 30_000 });
  });

  it("rejects an ambiguous owner before discovering catalog providers", async () => {
    const respond = vi.fn();
    await mocks.listRealtimeTranscriptionProviders.withImplementation(
      () => {
        throw new Error("provider discovery failed");
      },
      () =>
        callTalkHandler("talk.catalog", {
          params: {},
          respond,
          config: {
            agents: { ownership: "explicit", entries: { primary: {}, voice: {} } },
          },
        }),
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining("Talk session ownership has no explicit owner"),
    });
    expect(mocks.canonicalizeSpeechProviderId).not.toHaveBeenCalled();
    expect(mocks.listRealtimeTranscriptionProviders).not.toHaveBeenCalled();
    expect(mocks.listRealtimeVoiceProviders).not.toHaveBeenCalled();
  });

  it.each([
    ["talk.catalog", {}],
    ["talk.client.create", { provider: "openai" }],
    ["talk.session.create", { mode: "realtime", transport: "gateway-relay", provider: "openai" }],
  ] as const)("isolates a cold realtime owner for %s", async (method, params) => {
    markTalkOwnerCold("talk:realtime");
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      {
        id: "openai",
        label: "Realtime",
        resolveConfig: () => {
          throw new Error("cold SecretRef");
        },
      },
    ] as never);
    const respond = vi.fn();
    await callTalkHandler(method, {
      params,
      respond,
      config: { talk: { realtime: { provider: "openai" } } },
    });
    if (method === "talk.catalog") {
      expect(expectRespondOk(respond)).toMatchObject({
        realtime: { ready: false, providers: [{ configured: false }] },
      });
    } else {
      expectRespondError(respond, { code: ErrorCodes.UNAVAILABLE });
    }
  });

  it.each([[[]], [["transcribe-default", "transcribe-alternate"]]])(
    "returns safe catalogs with transcription models %j",
    async (models) => {
      mocks.listSpeechProviders.mockReturnValue([
        {
          id: "elevenlabs",
          label: "ElevenLabs",
          aliases: ["11labs"],
          models: ["eleven_flash_v2_5"],
          voices: ["voice-1"],
          isConfigured: vi.fn(() => true),
        } as never,
      ]);
      mocks.getResolvedSpeechProviderConfig.mockReturnValue({ apiKey: "speech-key" });
      mocks.listRealtimeTranscriptionProviders.mockReturnValue([
        {
          id: "openai",
          label: "OpenAI Realtime Transcription",
          aliases: ["openai-realtime"],
          defaultModel: "gpt-4o-transcribe",
          models,
          resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
          isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "stt-key"),
        } as never,
        {
          id: "deepgram",
          label: "Deepgram Realtime Transcription",
          aliases: ["deepgram-realtime"],
          resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
          isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "deepgram-key"),
        } as never,
      ]);
      mocks.listRealtimeVoiceProviders.mockReturnValue([
        {
          id: "google",
          label: "Google Live Voice",
          defaultModel: "gemini-live",
          resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
          isConfigured: vi.fn(
            ({ providerConfig }) =>
              providerConfig.apiKey === "live-key" &&
              providerConfig.project === "base" &&
              providerConfig.model === "talk-model",
          ),
          capabilities: {
            transports: ["provider-websocket", "gateway-relay"],
            inputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
            outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
            supportsBrowserSession: true,
            supportsBargeIn: true,
            supportsToolCalls: true,
            supportsVideoFrames: true,
            supportsSessionResumption: true,
          },
          createBrowserSession: vi.fn(),
          createBridge: vi.fn(),
        } as never,
        {
          id: "openai",
          label: "OpenAI Realtime",
          resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
          isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "openai-key"),
          createBridge: vi.fn(),
        } as never,
      ]);
      mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
        provider: { id: "google" },
        providerConfig: { apiKey: "live-key", project: "base", model: "talk-model" },
      } as never);

      const respond = vi.fn();
      await callTalkHandler("talk.catalog", {
        params: {},
        client: { connect: { scopes: ["operator.read"] } },
        respond,
        config: {
          talk: {
            provider: "elevenlabs",
            providers: { elevenlabs: { apiKey: "speech-key" } },
            realtime: {
              provider: "google",
              providers: {
                google: { apiKey: "live-key", project: "base" },
              },
              model: "talk-model",
            },
          },
          plugins: {
            entries: {
              "voice-call": {
                config: {
                  streaming: {
                    provider: "openai-realtime",
                    providers: { "openai-realtime": { apiKey: "stt-key" } },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
      });

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          modes: ["realtime", "stt-tts", "transcription"],
          transports: ["webrtc", "provider-websocket", "gateway-relay", "managed-room"],
          brains: ["agent-consult", "direct-tools", "none"],
          speech: {
            activeProvider: "elevenlabs",
            providers: [
              {
                id: "elevenlabs",
                label: "ElevenLabs",
                aliases: ["11labs"],
                configured: true,
                modes: ["stt-tts"],
                transports: ["gateway-relay", "managed-room"],
                brains: ["agent-consult"],
                models: ["eleven_flash_v2_5"],
                voices: ["voice-1"],
              },
            ],
          },
          transcription: {
            ready: true,
            activeProvider: "openai",
            providers: [
              {
                id: "openai",
                label: "OpenAI Realtime Transcription",
                aliases: ["openai-realtime"],
                configured: true,
                modes: ["transcription", "stt-tts"],
                transports: ["gateway-relay"],
                brains: ["none", "agent-consult"],
                defaultModel: "gpt-4o-transcribe",
                ...(models?.length ? { models } : {}),
              },
              {
                id: "deepgram",
                label: "Deepgram Realtime Transcription",
                aliases: ["deepgram-realtime"],
                configured: false,
                modes: ["transcription", "stt-tts"],
                transports: ["gateway-relay"],
                brains: ["none", "agent-consult"],
              },
            ],
          },
          realtime: {
            ready: true,
            activeProvider: "google",
            providers: [
              {
                id: "google",
                label: "Google Live Voice",
                configured: true,
                defaultModel: "gemini-live",
                modes: ["realtime"],
                transports: ["provider-websocket", "gateway-relay"],
                brains: ["agent-consult"],
                inputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
                outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
                supportsBrowserSession: true,
                supportsBargeIn: true,
                supportsToolCalls: true,
                supportsVideoFrames: true,
                supportsSessionResumption: true,
              },
              {
                id: "openai",
                label: "OpenAI Realtime",
                configured: false,
                modes: ["realtime"],
                brains: ["agent-consult"],
                supportsBrowserSession: false,
              },
            ],
          },
        },
        undefined,
      );
      const responsePayload = JSON.stringify(mockCallArg(respond, 0, 1));
      expect(responsePayload).not.toContain("speech-key");
      expect(responsePayload).not.toContain("stt-key");
      expect(responsePayload).not.toContain("live-key");
    },
  );

  it("emits realtime models and voices and mirrors create-time configured inputs", async () => {
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      defaultModel: "gpt-realtime-2.1",
      models: ["gpt-realtime-2.1"],
      voices: ["alloy", "marin"],
      resolveConfig: vi.fn(
        ({ rawConfig, agentId, surface }: RealtimeVoiceProviderResolveConfigContext) => ({
          ...rawConfig,
          model:
            rawConfig.model ??
            (agentId === "voice" && surface === "browser-session"
              ? "scoped-browser-default"
              : "legacy-default"),
        }),
      ),
      isConfigured: vi.fn(() => false),
      createBridge: vi.fn(),
      createBrowserSession: vi.fn(),
    };
    mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider: { id: "openai" },
      providerConfig: {},
    } as never);
    mocks.resolveRealtimeVoiceProviderCapabilities.mockReturnValueOnce({
      transports: ["gateway-relay"],
      inputAudioFormats: [],
      outputAudioFormats: [],
      voices: ["marin", "cedar"],
      voiceSelectionPolicy: "allowlist-default",
    });
    const respond = vi.fn();

    await callTalkHandler("talk.catalog", {
      params: {},
      client: { connect: { scopes: ["operator.read"] } },
      respond,
      context: {
        getRuntimeConfig: () =>
          ({
            talk: {
              agentId: "voice",
              realtime: {
                provider: "openai",
                providers: { openai: { model: "gpt-realtime-2.1" } },
                model: "gpt-live-test-canary",
              },
            },
          }) as OpenClawConfig,
      },
    });

    const catalog = expectRespondOk(respond) as {
      realtime: { providers: Array<Record<string, unknown>> };
    };
    expect(catalog.realtime.providers[0]).toMatchObject({
      defaultModel: "scoped-browser-default",
      models: ["gpt-realtime-2.1"],
      voices: ["alloy", "marin"],
      activeVoices: ["marin", "cedar"],
      activeVoiceSelectionPolicy: "allowlist-default",
    });
    expect(JSON.stringify(catalog)).not.toContain("gpt-live-test-canary");
    // Catalog readiness must mirror talk.client.create: top-level
    // talk.realtime.model overrides the provider-level model and the resolved
    // agent scope is consulted, or GPT-Live over OAuth reads as unconfigured.
    expect(mocks.resolveConfiguredRealtimeVoiceProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfigOverrides: { model: "gpt-live-test-canary" },
        agentId: expect.any(String),
      }),
    );
    expect(mocks.isRealtimeVoiceProviderConfigured).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: expect.any(String),
        providerConfig: expect.objectContaining({ model: "gpt-live-test-canary" }),
        surface: "browser-session",
      }),
    );
  });

  it.each([undefined, "force-agent-consult"])(
    "resolves the relay catalog default for consult policy %s",
    async (consultRouting) => {
      const autoRespondToAudio = consultRouting !== "force-agent-consult";
      const expectedModel = autoRespondToAudio ? "relay-default" : "manual-relay-default";
      const azure = { endpoint: "https://example.openai.azure.com" };
      const isConfigured = vi.fn(({ providerConfig }) => providerConfig.model === expectedModel);
      const provider = {
        id: "relay",
        label: "Relay Voice",
        defaultModel: "legacy-default",
        resolveConfig: vi.fn(
          ({
            rawConfig,
            agentId,
            surface,
            autoRespondToAudio: autoRespond,
          }: RealtimeVoiceProviderResolveConfigContext) => ({
            ...rawConfig,
            model:
              agentId === "voice" && surface === "gateway-relay" && rawConfig.azure !== undefined
                ? autoRespond === false
                  ? "manual-relay-default"
                  : "relay-default"
                : "legacy-default",
          }),
        ),
        voices: ["relay-default"],
        isConfigured,
        capabilities: {
          transports: ["gateway-relay"],
          supportsToolCalls: true,
        },
        createBridge: vi.fn(),
      };
      mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
      mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
        provider,
        providerConfig: {},
      } as never);
      const respond = vi.fn();

      await callTalkHandler("talk.catalog", {
        params: {},
        id: "relay-catalog",
        client: { connect: { scopes: ["operator.read"] } },
        respond,
        context: {
          getRuntimeConfig: () =>
            ({
              talk: {
                agentId: "voice",
                realtime: {
                  provider: "relay",
                  transport: "gateway-relay",
                  consultRouting,
                  providers: { relay: { azure } },
                },
              },
            }) as OpenClawConfig,
        },
      });

      expect(mocks.resolveConfiguredRealtimeVoiceProvider).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "voice", surface: "gateway-relay", autoRespondToAudio }),
      );
      expect(mocks.resolveRealtimeVoiceProviderCapabilities).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "voice",
          surface: "gateway-relay",
          providerConfig: { model: expectedModel, azure },
        }),
      );
      expect(isConfigured).toHaveBeenCalledWith(expect.not.objectContaining({ surface: "bridge" }));
      const catalog = expectRespondOk(respond);
      expect(catalog.realtime).toEqual(expect.objectContaining({ ready: true }));
      expect(catalog.realtime.providers[0]).toMatchObject({
        configured: true,
        defaultModel: expectedModel,
        voices: ["relay-default"],
      });
      expect(provider.resolveConfig).toHaveBeenCalledOnce();
    },
  );

  it.each(["realtime-fast", "realtime-fast-alias"])(
    "reports the runtime-selected automatic providers and configured rows for %s",
    async (configKey) => {
      const transcriptionSlow = {
        id: "transcription-slow",
        label: "Transcription Slow",
        autoSelectOrder: 20,
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.enabled === true),
      };
      const transcriptionFast = {
        id: "transcription-fast",
        label: "Transcription Fast",
        models: ["transcribe-model"],
        autoSelectOrder: 10,
        isConfigured: vi.fn(
          ({ providerConfig }) =>
            providerConfig.enabled === true && providerConfig.model === "transcribe-model",
        ),
      };
      const realtimeSlow = {
        id: "realtime-slow",
        label: "Realtime Slow",
        autoSelectOrder: 20,
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.enabled === true),
        createBridge: vi.fn(),
      };
      const realtimeFast = {
        id: "realtime-fast",
        aliases: ["realtime-fast-alias"],
        label: "Realtime Fast",
        autoSelectOrder: 10,
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.enabled === true),
        createBridge: vi.fn(),
      };
      mocks.listRealtimeTranscriptionProviders.mockReturnValue([
        transcriptionSlow,
        transcriptionFast,
      ] as never);
      mocks.listRealtimeVoiceProviders.mockReturnValue([realtimeSlow, realtimeFast] as never);
      mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
        provider: realtimeFast,
        providerConfig: { enabled: true },
      } as never);

      const respond = vi.fn();
      await callTalkHandler("talk.catalog", {
        params: {},
        client: { connect: { scopes: ["operator.read"] } },
        respond,
        config: {
          agents: {
            defaults: {
              voiceModel: { primary: "transcription-fast/transcribe-model" },
            },
          },
          talk: {
            realtime: {
              providers: {
                "realtime-slow": { enabled: true },
                [configKey]: { enabled: true },
              },
            },
          },
          plugins: {
            entries: {
              "voice-call": {
                config: {
                  streaming: {
                    providers: {
                      "transcription-slow": { enabled: true },
                      "transcription-fast": { enabled: true },
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
      });

      expect(mockCallArg(respond, 0, 1)).toMatchObject({
        transcription: {
          ready: true,
          activeProvider: "transcription-fast",
          providers: [
            { id: "transcription-slow", configured: true },
            { id: "transcription-fast", configured: true },
          ],
        },
        realtime: {
          ready: true,
          activeProvider: "realtime-fast",
          providers: [
            { id: "realtime-slow", configured: true },
            { id: "realtime-fast", configured: true },
          ],
        },
      });
    },
  );

  it("includes a provider-map transcription provider missing from the active registry", async () => {
    const openai = {
      id: "openai",
      label: "OpenAI Realtime Transcription",
      isConfigured: vi.fn(() => false),
    };
    const xai = {
      id: "xai",
      label: "xAI Realtime Transcription",
      resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
      isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "xai-key"),
    };
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([openai] as never);
    mocks.getRealtimeTranscriptionProvider.mockImplementation((providerId: string | undefined) =>
      providerId === "xai" ? (xai as never) : undefined,
    );

    const respond = vi.fn();
    await callTalkHandler("talk.catalog", {
      params: {},
      client: { connect: { scopes: ["operator.read"] } },
      respond,
      config: {
        plugins: {
          entries: {
            "voice-call": {
              config: {
                streaming: {
                  providers: { xai: { apiKey: "xai-key" } },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(mockCallArg(respond, 0, 1)).toMatchObject({
      transcription: {
        ready: true,
        activeProvider: "xai",
        providers: [
          { id: "openai", configured: false },
          { id: "xai", configured: true },
        ],
      },
    });
  });

  it("reports the provider selected by runtime resolution when aliases collide", async () => {
    const transcriptionAlias = {
      id: "transcription-alias",
      label: "Transcription Alias",
      aliases: ["shared-transcription"],
      isConfigured: vi.fn(() => true),
    };
    const transcriptionDirect = {
      id: "shared-transcription",
      label: "Transcription Direct",
      isConfigured: vi.fn(() => true),
    };
    const realtimeAlias = {
      id: "realtime-alias",
      label: "Realtime Alias",
      aliases: ["shared-realtime"],
      isConfigured: vi.fn(() => true),
      createBridge: vi.fn(),
    };
    const realtimeDirect = {
      id: "shared-realtime",
      label: "Realtime Direct",
      isConfigured: vi.fn(() => true),
      createBridge: vi.fn(),
    };
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      transcriptionAlias,
      transcriptionDirect,
    ] as never);
    mocks.listRealtimeVoiceProviders.mockReturnValue([realtimeAlias, realtimeDirect] as never);
    mocks.canonicalizeRealtimeTranscriptionProviderId.mockReturnValueOnce("shared-transcription");
    mocks.canonicalizeRealtimeVoiceProviderId.mockReturnValueOnce("shared-realtime");
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider: realtimeAlias,
      providerConfig: { enabled: true },
    } as never);

    const respond = vi.fn();
    await callTalkHandler("talk.catalog", {
      params: {},
      client: { connect: { scopes: ["operator.read"] } },
      respond,
      config: {
        talk: {
          realtime: {
            provider: "shared-realtime",
            providers: { "shared-realtime": { enabled: true } },
          },
        },
        plugins: {
          entries: {
            "voice-call": {
              config: {
                streaming: {
                  provider: "shared-transcription",
                  providers: { "shared-transcription": { enabled: true } },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(mockCallArg(respond, 0, 1)).toMatchObject({
      transcription: { ready: true, activeProvider: "transcription-alias" },
      realtime: { ready: true, activeProvider: "realtime-alias" },
    });
  });

  it.each([false, true])(
    "reports unavailable catalog providers with explicit selection=%s",
    async (explicit) => {
      mocks.listRealtimeTranscriptionProviders.mockReturnValue([
        { id: "transcription", label: "Transcription", isConfigured: vi.fn(() => false) },
      ] as never);
      mocks.listRealtimeVoiceProviders.mockReturnValue([
        {
          id: "realtime",
          label: "Realtime",
          isConfigured: vi.fn(() => false),
          createBridge: vi.fn(),
        },
      ] as never);
      mocks.resolveConfiguredRealtimeVoiceProvider.mockImplementation(() => {
        throw new Error(
          explicit
            ? "Realtime provider is not configured"
            : "No realtime voice provider configured",
        );
      });
      const respond = vi.fn();
      await callTalkHandler("talk.catalog", {
        params: {},
        client: { connect: { scopes: ["operator.read"] } },
        respond,
        config: explicit
          ? {
              talk: { realtime: { provider: "realtime" } },
              plugins: {
                entries: { "voice-call": { config: { streaming: { provider: "transcription" } } } },
              },
            }
          : {},
      });
      const catalog = mockCallArg(respond, 0, 1) as Record<string, Record<string, unknown>>;
      for (const kind of ["transcription", "realtime"]) {
        expect(catalog[kind]).toMatchObject({ ready: false });
        if (explicit) {
          expect(catalog[kind]).toMatchObject({ activeProvider: kind });
        } else {
          expect(catalog[kind]).not.toHaveProperty("activeProvider");
        }
      }
    },
  );
});
