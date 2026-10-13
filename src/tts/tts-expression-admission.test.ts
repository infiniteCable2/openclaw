import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveTtsDirectiveFacts } from "./directives.js";
import {
  acquireSpeechProviderLocalServiceMock,
  clearRuntimeConfigSnapshot,
  createMockSpeechProvider,
  createTtsConfig,
  installSpeechProviders,
  maybeApplyTtsToPayload,
  prepareSynthesisMock,
  prepareTextToSpeech,
  resolveTtsConfig,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  synthesizeSpeech,
  streamTextToSpeechTelephony,
  textToSpeechStream,
  textToSpeechTelephony,
  textToSpeechCore,
  type SpeechSynthesisRequest,
  type SpeechTelephonySynthesisRequest,
  type OpenClawConfig,
} from "./tts-runtime.test-support.js";

const capabilities = { emotions: ["joyful"], vocalEvents: [], emphasis: false, whisper: false };
const config: OpenClawConfig = {
  tts: {
    provider: "mock",
    providers: { mock: { model: "expressive", baseUrl: "http://127.0.0.1:8020/v1" } },
  },
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

afterEach(() => {
  setTtsMachinePrefsPathResolver();
  clearRuntimeConfigSnapshot();
  acquireSpeechProviderLocalServiceMock.mockReset();
  prepareSynthesisMock.mockClear();
  synthesizeMock.mockClear();
  installSpeechProviders([createMockSpeechProvider()]);
});

describe("native speech expression admission", () => {
  const selectionModes = ["channel-stream", "telephony", "telephony-stream"] as const;
  async function preparedSelectionFixture(mode: (typeof selectionModes)[number]) {
    const admission = { generation: "selection-worker", signal: new AbortController().signal };
    acquireSpeechProviderLocalServiceMock.mockResolvedValue({ release: vi.fn(), admission });
    const streamResult = () => ({
      audioStream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      outputFormat: "pcm",
      fileExtension: ".pcm",
      sampleRate: 24_000,
      voiceCompatible: true,
    });
    const stream = vi.fn(async (_request: SpeechSynthesisRequest) => streamResult());
    const telephonyStream = vi.fn(async (_request: SpeechTelephonySynthesisRequest) =>
      streamResult(),
    );
    const telephony = vi.fn(async (_request: SpeechTelephonySynthesisRequest) => ({
      audioBuffer: Buffer.from("voice"),
      outputFormat: "pcm",
      sampleRate: 24_000,
    }));
    const prepareCapabilities = vi.fn(async () => undefined);
    const getCapabilities = vi.fn(() => capabilities);
    const provider = createMockSpeechProvider("mock", {
      prepareExpressionCapabilities: prepareCapabilities,
      getExpressionCapabilities: getCapabilities,
      streamSynthesize: stream,
      streamSynthesizeTelephony: telephonyStream,
      synthesizeTelephony: telephony,
    });
    installSpeechProviders([provider]);
    const selectedConfig: OpenClawConfig = {
      ...config,
      tts: {
        ...createTtsConfig("openclaw-stream-selection").tts,
        providers: { mock: { model: "prepared-model", voice: "prepared-voice" } },
      },
    };
    const ready = await prepareTextToSpeech({
      cfg: selectedConfig,
      target: mode === "channel-stream" ? "voice-note" : "telephony",
      agentId: "reader",
      channelId: "matrix",
    });
    try {
      expect(ready).toMatchObject({
        success: true,
        provider: "mock",
        providerModel: "prepared-model",
        providerVoice: "prepared-voice",
        localServiceAdmission: admission,
      });
    } catch (error) {
      await ready.release?.();
      throw error;
    }
    const expectedSpeechSelection = {
      provider: "mock",
      model: ready.providerModel,
      voice: ready.providerVoice,
    };
    const dispatch = (
      cfg: OpenClawConfig,
      overrides: Parameters<typeof synthesizeSpeech>[0]["overrides"] = {
        expression: { parts: [{ text: "Hello." }] },
      },
    ) => {
      const common = {
        cfg,
        text: "Hello.",
        agentId: "reader",
        overrides,
        expectedSpeechSelection,
        localServiceAdmission: ready.localServiceAdmission,
      };
      switch (mode) {
        case "channel-stream":
          return textToSpeechStream({ ...common, channel: "matrix" });
        case "telephony":
          return textToSpeechTelephony({ ...common, channelId: "matrix" });
        case "telephony-stream":
          return streamTextToSpeechTelephony({ ...common, channelId: "matrix" });
      }
      throw new Error(`Unexpected speech selection mode: ${mode}`);
    };
    return {
      ready,
      selectedConfig,
      provider,
      dispatch,
      stream,
      telephonyStream,
      telephony,
      prepareCapabilities,
      getCapabilities,
    };
  }

  it.each(selectionModes)(
    "keeps expression capability hooks cold for plain %s output",
    async (mode) => {
      const fixture = await preparedSelectionFixture(mode);
      fixture.prepareCapabilities.mockClear();
      fixture.getCapabilities.mockClear();
      fixture.prepareCapabilities.mockImplementation(async () => {
        throw new Error("Plain speech must not prepare expression capabilities");
      });
      fixture.getCapabilities.mockImplementation(() => {
        throw new Error("Plain speech must not read expression capabilities");
      });
      try {
        const result = await fixture.dispatch(fixture.selectedConfig, {});
        try {
          expect(result.success).toBe(true);
          expect(fixture.prepareCapabilities).not.toHaveBeenCalled();
          expect(fixture.getCapabilities).not.toHaveBeenCalled();
        } finally {
          if ("release" in result) {
            await result.release?.();
          }
        }
      } finally {
        await fixture.ready.release?.();
      }
    },
  );

  it.each(
    selectionModes.flatMap((mode) => ["model", "voice"].map((changed) => ({ mode, changed }))),
  )(
    "refuses same-worker $changed changes after real native readiness through $mode",
    async ({ mode, changed }) => {
      const fixture = await preparedSelectionFixture(mode);
      try {
        const result = await fixture.dispatch({
          ...fixture.selectedConfig,
          tts: {
            ...fixture.selectedConfig.tts,
            providers: {
              mock: {
                model: changed === "model" ? "replacement-model" : "prepared-model",
                voice: changed === "voice" ? "replacement-voice" : "prepared-voice",
              },
            },
          },
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain("model or voice changed");
        expect(fixture.stream).not.toHaveBeenCalled();
        expect(fixture.telephony).not.toHaveBeenCalled();
        expect(fixture.telephonyStream).not.toHaveBeenCalled();
      } finally {
        await fixture.ready.release?.();
      }
    },
  );

  it.each(
    selectionModes.flatMap((mode) => [true, false].map((allowVoice) => ({ mode, allowVoice }))),
  )(
    "retains native allowVoice=$allowVoice overrides through $mode",
    async ({ mode, allowVoice }) => {
      const fixture = await preparedSelectionFixture(mode);
      try {
        const cfg = {
          ...fixture.selectedConfig,
          tts: {
            ...fixture.selectedConfig.tts,
            modelOverrides: { allowVoice },
          },
        };
        const { overrides } = resolveTtsDirectiveFacts(
          {
            tagged: true,
            text: "Hello.",
            expression: { parts: [{ text: "Hello." }] },
            directives: [{ values: { speakervoice: "requested-voice" } }],
          },
          resolveTtsConfig(cfg).modelOverrides,
          { providers: [fixture.provider], preferredProviderId: "mock" },
        );
        const result = await fixture.dispatch(cfg, overrides);
        try {
          expect(result.success).toBe(true);
          expect(result.providerVoice).toBe(allowVoice ? "requested-voice" : "prepared-voice");
        } finally {
          if ("release" in result) {
            await result.release?.();
          }
        }
      } finally {
        await fixture.ready.release?.();
      }
    },
  );

  it.each([
    { auto: "always", inboundAudio: false, expressionRequired: true },
    { auto: "always", inboundAudio: true, expressionRequired: true },
    { auto: "inbound", inboundAudio: true, expressionRequired: true },
    { auto: "inbound", inboundAudio: false, expressionRequired: false },
    { auto: "off", inboundAudio: true, expressionRequired: false },
    { auto: "tagged", inboundAudio: true, expressionRequired: false },
  ] as const)(
    "aligns final expression requirements with $auto and originating audio=$inboundAudio",
    async ({ auto, inboundAudio, expressionRequired }) => {
      const base = createTtsConfig("openclaw-expression-output-policy");
      const payload = { text: "This is a complete response to the original request." };
      const pending = maybeApplyTtsToPayload({
        cfg: { ...base, talk: config.talk, tts: { ...base.tts, auto } },
        payload,
        channel: "matrix",
        agentId: "reader",
        kind: "final",
        inboundAudio,
      });
      if (expressionRequired) {
        await expect(pending).rejects.toThrow("requires a native structured expression");
      } else {
        expect(await pending).toBe(payload);
      }
      expect(synthesizeMock).not.toHaveBeenCalled();
      expect(acquireSpeechProviderLocalServiceMock).not.toHaveBeenCalled();
    },
  );

  it("releases a queued service lease when caller cancellation wins acquisition", async () => {
    const caller = new AbortController();
    const worker = new AbortController();
    const admission = { generation: "worker1", signal: worker.signal };
    const release = vi.fn();
    const entered = createDeferred();
    const acquired = createDeferred<{ release: () => void; admission: typeof admission }>();
    acquireSpeechProviderLocalServiceMock.mockImplementationOnce(async ({ signal }) => {
      expect(signal).toBe(caller.signal);
      entered.resolve(undefined);
      return await acquired.promise;
    });
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        getExpressionCapabilities: () => capabilities,
      }),
    ]);
    const persist = vi.fn(async () => "unused");
    const pending = textToSpeechCore(
      {
        cfg: config,
        text: "Hello.",
        channel: "matrix",
        agentId: "reader",
        signal: caller.signal,
        overrides: { expression: { parts: [{ text: "Hello." }] } },
      },
      persist,
    );
    const rejected = expect(pending).rejects.toThrow("Caller cancelled queued speech");
    await entered.promise;
    caller.abort(new Error("Caller cancelled queued speech"));
    acquired.resolve({ release, admission });
    await rejected;
    expect(prepareSynthesisMock).not.toHaveBeenCalled();
    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(worker.signal.aborted).toBe(false);
  });

  it.each(["caller", "worker"] as const)(
    "rejects %s cancellation while buffered synthesis runs, with no persistence or fallback",
    async (cancelOwner) => {
      const caller = new AbortController();
      const worker = new AbortController();
      const admission = { generation: "worker1", signal: worker.signal };
      const release = vi.fn();
      acquireSpeechProviderLocalServiceMock.mockResolvedValue({ release, admission });
      const entered = createDeferred<SpeechSynthesisRequest>();
      const audio = createDeferred<Awaited<ReturnType<typeof synthesizeMock>>>();
      const synthesize = vi.fn(async (request: SpeechSynthesisRequest) => {
        entered.resolve(request);
        // Deliberately model a transport that settles late despite interruption.
        return await audio.promise;
      });
      installSpeechProviders([
        createMockSpeechProvider("mock", {
          synthesize,
          getExpressionCapabilities: () => capabilities,
        }),
        createMockSpeechProvider("fallback", { getExpressionCapabilities: () => capabilities }),
      ]);
      const persist = vi.fn(async () => "unused");
      const pending = textToSpeechCore(
        {
          cfg: config,
          text: "Hello.",
          channel: "matrix",
          agentId: "reader",
          signal: caller.signal,
          localServiceAdmission: admission,
          overrides: { expression: { parts: [{ text: "Hello." }] } },
        },
        persist,
      );
      const rejected = expect(pending).rejects.toThrow("Speech owner cancelled");
      const request = await entered.promise;
      expect(request.signal).toBe(caller.signal);
      expect(request.localServiceAdmission).toBe(admission);
      expect(prepareSynthesisMock.mock.calls[0]?.[0].signal).toBe(caller.signal);
      const error = new Error("Speech owner cancelled");
      error.name = "LocalServiceAdmissionError";
      (cancelOwner === "caller" ? caller : worker).abort(error);
      audio.resolve({
        audioBuffer: Buffer.from("discarded"),
        fileExtension: ".ogg",
        outputFormat: "ogg",
        voiceCompatible: true,
      });
      await rejected;
      expect(persist).not.toHaveBeenCalled();
      expect(synthesize).toHaveBeenCalledOnce();
      expect(synthesizeMock).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect((cancelOwner === "caller" ? worker : caller).signal.aborted).toBe(false);
    },
  );

  it("prepares actual capabilities on the retained native readiness lease without synthesizing", async () => {
    const admission = { generation: "worker1", signal: new AbortController().signal };
    const release = vi.fn();
    acquireSpeechProviderLocalServiceMock.mockResolvedValue({ release, admission });
    let admitted = false;
    const prepare = vi.fn(
      async ({ localServiceAdmission }: { localServiceAdmission?: typeof admission }) => {
        expect(localServiceAdmission).toBe(admission);
        expect(acquireSpeechProviderLocalServiceMock).toHaveBeenCalledOnce();
        admitted = true;
      },
    );
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        prepareExpressionCapabilities: prepare,
        getExpressionCapabilities: ({ localServiceAdmission }) =>
          admitted && localServiceAdmission === admission ? capabilities : undefined,
      }),
    ]);
    const result = await prepareTextToSpeech({
      cfg: config,
      target: "voice-note",
      agentId: "reader",
      channelId: "matrix",
    });
    expect(result.success).toBe(true);
    expect(result.expressionCapabilities).toBe(capabilities);
    expect(result.localServiceAdmission).toBe(admission);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepareSynthesisMock).toHaveBeenCalledOnce();
    expect(prepareSynthesisMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        target: "voice-note",
        localServiceAdmission: admission,
      }),
    );
    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await result.release?.();
    expect(release).toHaveBeenCalledOnce();
  });

  it("admits a cold expression after local-service preparation instead of rejecting cached absence", async () => {
    const admission = { generation: "worker1", signal: new AbortController().signal };
    const release = vi.fn();
    acquireSpeechProviderLocalServiceMock.mockResolvedValue({ release, admission });
    let admitted = false;
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        prepareExpressionCapabilities: async () => {
          admitted = true;
        },
        getExpressionCapabilities: ({ localServiceAdmission }) =>
          admitted && localServiceAdmission === admission ? capabilities : undefined,
      }),
    ]);
    const result = await synthesizeSpeech({
      cfg: config,
      text: "Hello.",
      agentId: "reader",
      channel: "matrix",
      overrides: { expression: { emotion: "joyful", parts: [{ text: "Hello." }] } },
    });
    expect(result.success).toBe(true);
    expect(synthesizeMock.mock.calls[0]?.[0].localServiceAdmission).toBe(admission);
    expect(release).toHaveBeenCalledOnce();
  });

  it("binds readiness and synthesis to the same provider-prepared persona/model/voice winner", async () => {
    const admission = { generation: "worker1", signal: new AbortController().signal };
    const release = vi.fn();
    acquireSpeechProviderLocalServiceMock.mockResolvedValue({ release, admission });
    const selectedConfig: OpenClawConfig = {
      ...config,
      tts: {
        ...config.tts,
        persona: "narrator",
        personas: {
          narrator: { providers: { mock: { voiceId: "persona-voice" } } },
        },
      },
    };
    const prepareSelection = vi.fn(
      async (
        context: Parameters<
          NonNullable<ReturnType<typeof createMockSpeechProvider>["prepareSynthesis"]>
        >[0],
      ) => {
        expect(context.personaProviderConfig?.voiceId).toBe("persona-voice");
        expect(context.providerOverrides?.modelId).toBe("requested-model");
        return {
          providerConfig: {
            model: "prepared-model",
            modelId: "prepared-model",
            speakerVoiceId: "prepared-voice",
          },
          providerOverrides: { modelId: "prepared-model", speakerVoiceId: "prepared-voice" },
        };
      },
    );
    const prepareCapabilities = vi.fn(
      async (context: {
        providerConfig: Record<string, unknown>;
        providerOverrides?: Record<string, unknown>;
      }) => {
        expect(context.providerConfig.model).toBe("prepared-model");
        expect(context.providerOverrides?.modelId).toBe("prepared-model");
        expect(context.providerOverrides?.speakerVoiceId).toBe("prepared-voice");
      },
    );
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        prepareSynthesis: prepareSelection,
        prepareExpressionCapabilities: prepareCapabilities,
        getExpressionCapabilities: ({ providerConfig }) =>
          providerConfig.model === "prepared-model" ? capabilities : undefined,
      }),
    ]);
    const providerOverrides = { mock: { modelId: "requested-model" } };
    const ready = await prepareTextToSpeech({
      cfg: selectedConfig,
      target: "voice-note",
      agentId: "reader",
      channelId: "matrix",
      overrides: { providerOverrides },
    });
    expect(ready.success).toBe(true);
    expect(ready).toMatchObject({
      provider: "mock",
      providerModel: "prepared-model",
      providerVoice: "prepared-voice",
    });
    expect(ready.expressionCapabilities).toBe(capabilities);
    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    const result = await synthesizeSpeech({
      cfg: selectedConfig,
      text: "Hello.",
      agentId: "reader",
      channel: "matrix",
      expectedSpeechSelection: {
        provider: "mock",
        model: ready.providerModel,
        voice: ready.providerVoice,
      },
      localServiceAdmission: admission,
      overrides: { providerOverrides, expression: { parts: [{ text: "Hello." }] } },
    });
    expect(result.success).toBe(true);
    expect(prepareSelection).toHaveBeenCalledTimes(2);
    expect(prepareCapabilities).toHaveBeenCalledTimes(2);
    expect(synthesizeMock).toHaveBeenCalledOnce();
    await ready.release?.();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("preserves preparation-free plain telephony readiness", async () => {
    const release = vi.fn();
    acquireSpeechProviderLocalServiceMock.mockResolvedValue({ release });
    const prepareSelection = vi.fn(async () => {
      throw new Error("Plain readiness must not prepare synthesis");
    });
    const prepareCapabilities = vi.fn(async () => {
      throw new Error("Plain readiness must not prepare expression capabilities");
    });
    const getCapabilities = vi.fn(() => {
      throw new Error("Plain readiness must not read expression capabilities");
    });
    const telephony = vi.fn(async () => ({
      audioBuffer: Buffer.from("unused"),
      outputFormat: "pcm",
      sampleRate: 24_000,
    }));
    installSpeechProviders([
      createMockSpeechProvider("mock", {
        prepareSynthesis: prepareSelection,
        prepareExpressionCapabilities: prepareCapabilities,
        getExpressionCapabilities: getCapabilities,
        synthesizeTelephony: telephony,
      }),
    ]);
    const ready = await prepareTextToSpeech({
      cfg: config,
      target: "telephony",
      agentId: "other",
      channelId: "matrix",
    });
    expect(ready.success).toBe(true);
    expect(prepareSelection).not.toHaveBeenCalled();
    expect(prepareCapabilities).not.toHaveBeenCalled();
    expect(getCapabilities).not.toHaveBeenCalled();
    expect(telephony).not.toHaveBeenCalled();
    expect(synthesizeMock).not.toHaveBeenCalled();
    await ready.release?.();
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses a replaced pre-model generation without fallback or capability rediscovery", async () => {
    const original = { generation: "worker1", signal: new AbortController().signal };
    const replacement = { generation: "worker2", signal: new AbortController().signal };
    const release = vi.fn();
    acquireSpeechProviderLocalServiceMock.mockResolvedValue({ release, admission: replacement });
    const prepare = vi.fn(async () => undefined);
    installSpeechProviders([
      createMockSpeechProvider("mock", { prepareExpressionCapabilities: prepare }),
      createMockSpeechProvider("fallback", { getExpressionCapabilities: () => capabilities }),
    ]);
    const result = await synthesizeSpeech({
      cfg: config,
      text: "Hello.",
      agentId: "reader",
      channel: "matrix",
      localServiceAdmission: original,
      overrides: { expression: { parts: [{ text: "Hello." }] } },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("generation changed");
    expect(result.attemptedProviders).toEqual(["mock"]);
    expect(prepare).not.toHaveBeenCalled();
    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
