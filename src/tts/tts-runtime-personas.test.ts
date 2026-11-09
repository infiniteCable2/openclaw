import { afterEach, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { MessageSpeechAdmission } from "./message-speech-admission.js";
import {
  createMockSpeechProvider,
  installSpeechProviders,
  maybeApplyTtsToPayload,
  maybeApplyTtsToPayloadCore,
  prepareTextToSpeechTelephony,
  prepareSynthesisMock,
  acquireSpeechProviderLocalServiceMock,
  requireFirstCallParam,
  requireFirstSynthesisRequest,
  requireRecord,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  synthesizeSpeech,
  streamTextToSpeechTelephony,
  textToSpeechStream,
  textToSpeechTelephony,
  type OpenClawConfig,
  type SpeechTelephonySynthesisRequest,
  type SpeechSynthesisRequest,
  resetTtsRuntime,
} from "./tts-runtime.test-support.js";

afterEach(() => resetTtsRuntime());
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
              (mode === "telephony" ? telephony : mode === "stream" ? stream : telephonyStream).mock
                .calls,
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
    const plain = await dispatch("other");
    expect(plain.success).toBe(true);
    const plainRequest = requireFirstCallParam(
      (mode === "buffered"
        ? synthesizeMock
        : mode === "telephony"
          ? telephony
          : mode === "stream"
            ? stream
            : telephonyStream
      ).mock.calls,
      "disabled expression plain synthesis",
    );
    expect(plainRequest).toMatchObject({ text: "Hello there." });
    expect(plainRequest).not.toHaveProperty("expression");
    if ("release" in plain) {
      await plain.release?.();
    }
    acquireSpeechProviderLocalServiceMock.mockClear();

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
        cfg: {
          tts: { provider: "mock" },
          talk: {
            speech: {
              agentProfiles: {
                reader: { expression: { channels: { matrix: { targets: ["voice-note"] } } } },
              },
            },
          },
        },
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
