import { afterEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import {
  acquireSpeechProviderLocalServiceMock,
  clearRuntimeConfigSnapshot,
  createMockSpeechProvider,
  installSpeechProviders,
  maybeApplyTtsToPayloadCore,
  prepareSynthesisMock,
  requireFirstCallParam,
  requireFirstSynthesisRequest,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  synthesizeSpeech,
  streamTextToSpeechTelephony,
  textToSpeechStream,
  textToSpeechTelephony,
  transcodeAudioBufferMock,
  type SpeechSynthesisRequest,
  type SpeechTelephonySynthesisRequest,
} from "./tts-runtime.test-support.js";

afterEach(() => {
  setTtsMachinePrefsPathResolver();
  clearRuntimeConfigSnapshot();
  clearSecretsRuntimeSnapshot();
  synthesizeMock.mockClear();
  prepareSynthesisMock.mockClear();
  acquireSpeechProviderLocalServiceMock.mockClear();
  transcodeAudioBufferMock.mockClear();
  installSpeechProviders([createMockSpeechProvider()]);
});

describe("disabled optional speech expression", () => {
  it.each(["buffered", "telephony", "stream", "telephony-stream"] as const)(
    "ignores stale unsupported controls with cold capability hooks on disabled %s output",
    async (mode) => {
      const prepareCapabilities = vi.fn(async () => {
        throw new Error("Disabled output must not prepare expression capabilities");
      });
      const getCapabilities = vi.fn(() => {
        throw new Error("Disabled output must not read expression capabilities");
      });
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
      installSpeechProviders([
        createMockSpeechProvider("mock", {
          prepareExpressionCapabilities: prepareCapabilities,
          getExpressionCapabilities: getCapabilities,
          streamSynthesize: stream,
          streamSynthesizeTelephony: telephonyStream,
          synthesizeTelephony: telephony,
        }),
      ]);
      const common = {
        cfg: { tts: { provider: "mock" } },
        text: "**Plain words only.**",
        agentId: "reader",
        overrides: {
          expression: {
            emotion: "not_supported",
            parts: [{ text: "Different words." }, { event: "not_supported" }],
          },
        },
      };
      const result =
        mode === "buffered"
          ? await synthesizeSpeech({ ...common, channel: "matrix" })
          : mode === "stream"
            ? await textToSpeechStream({ ...common, channel: "matrix" })
            : mode === "telephony"
              ? await textToSpeechTelephony({ ...common, channelId: "matrix" })
              : await streamTextToSpeechTelephony({ ...common, channelId: "matrix" });
      expect(result.success).toBe(true);
      expect(prepareCapabilities).not.toHaveBeenCalled();
      expect(getCapabilities).not.toHaveBeenCalled();
      const request = requireFirstCallParam(
        (mode === "buffered"
          ? synthesizeMock
          : mode === "stream"
            ? stream
            : mode === "telephony"
              ? telephony
              : telephonyStream
        ).mock.calls,
        "disabled presentation",
      );
      expect(request).toMatchObject({
        text: mode === "buffered" || mode === "stream" ? "Plain words only." : common.text,
      });
      expect(request).not.toHaveProperty("expression");
      if ("release" in result) {
        await result.release?.();
      }
    },
  );

  it("delivers clean text and ordinary TTS when optional expression metadata is disabled", async () => {
    const payload = setReplyPayloadMetadata(
      { text: "Visible answer." },
      {
        ttsExplicit: true,
        tts: {
          tagged: true,
          text: "Spoken answer.",
          expression: { emotion: "unsupported", parts: [{ text: "Mismatched expression words." }] },
        },
      },
    );
    const persist = vi.fn(async () => "fixture-voice.ogg");
    const result = await maybeApplyTtsToPayloadCore(
      {
        cfg: { tts: { provider: "mock", auto: "off" } },
        payload,
        channel: "matrix",
        agentId: "reader",
        preparedTtsPreferences: {},
      },
      persist,
    );
    expect(result).toMatchObject({
      text: "Visible answer.",
      spokenText: "Spoken answer.",
      mediaUrl: "fixture-voice.ogg",
    });
    const request = requireFirstSynthesisRequest("disabled expression payload");
    expect(request.text).toBe("Spoken answer.");
    expect(request).not.toHaveProperty("expression");
  });
});
