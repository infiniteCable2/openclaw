import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import type { RealtimeVoiceProviderPlugin } from "../../plugins/types.js";
import type { RealtimeVoiceAgentConsultResult } from "../agent-consult-runtime.js";
import type { RealtimeVoiceAgentConsultToolPolicy } from "../agent-consult-tool.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../provider-contexts.js";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "../provider-types.js";
import type { RealtimeVoiceBridge } from "../provider-types.js";
import { startSpeechRealtimeSession } from "./provider-session.js";
import type { SpeechAudioTransport } from "./transport.js";
import type { SpeechAgentConsultParams } from "./types.js";

async function createLiveFixture(
  options: {
    isolated?: boolean;
    continuous?: boolean;
    echoSuppressionTailSeconds?: number;
    toolPolicy?: RealtimeVoiceAgentConsultToolPolicy;
    connect?: () => Promise<void>;
    consultAgent?: (params: SpeechAgentConsultParams) => Promise<{ text: string }>;
  } = {},
) {
  const continuous = options.continuous ?? true;
  let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
  let input: ((audio: Buffer) => void) | undefined;
  const sendAudio = vi.fn();
  const handleBargeIn = vi.fn();
  const bridge: RealtimeVoiceBridge = {
    connect: options.connect ?? (async () => {}),
    close: vi.fn(),
    isConnected: () => true,
    outputAudioMode: continuous ? "continuous" : "response",
    handlesInputAudioBargeIn: continuous,
    sendAudio,
    handleBargeIn,
    setMediaTimestamp: vi.fn(),
    acknowledgeMark: vi.fn(),
    submitToolResult: vi.fn(),
  };
  const provider: RealtimeVoiceProviderPlugin = {
    id: "test-native",
    label: "Test native voice",
    isConfigured: () => true,
    createBridge: (request) => {
      callbacks = request;
      return bridge;
    },
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: {
      isBrowserSessionConfigured: () => true,
      resolveGatewayRelayCapabilities: () => ({
        transports: ["gateway-relay"],
        inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        supportsBargeIn: !continuous,
        handlesInputAudioBargeIn: continuous,
        handlesAgentConsult: true,
      }),
    },
  });
  const writeOutput = vi.fn(async (_audio: Buffer) => {});
  const clearOutput = vi.fn(async () => {});
  const startBargeInMonitor = vi.fn();
  const consultAgent = vi.fn(options.consultAgent ?? (async () => ({ text: "The answer." })));
  const handleToolCall = vi.fn(async () => {});
  const transport: SpeechAudioTransport = {
    inputAudioIsolated: options.isolated ?? true,
    startInput: (handler) => {
      input = handler;
    },
    onFatal: vi.fn(),
    stop: async () => {},
    dispose: async () => {},
    writeOutput,
    clearOutput,
    startBargeInMonitor,
  };
  const handle = await startSpeechRealtimeSession({
    config: {
      audioFormat: "pcm16-24khz",
      echoSuppressionTailSeconds: options.echoSuppressionTailSeconds,

      strategy: "bidi",
      provider: provider.id,
      providers: {},
      toolPolicy: options.toolPolicy ?? "safe-read-only",
    },
    fullConfig: {},
    runtime: createPluginRuntime(),
    surface: { displayName: "Test Meeting", logScope: "[meeting]", sessionIdPrefix: "meeting" },
    sessionId: "meeting-1",
    requesterSessionKey: "agent:main:requester",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    providers: [provider],
    transport,
    consultAgent,
    tools: [],
    handleToolCall,
  });
  if (!callbacks || !input) {
    throw new Error("Expected connected meeting provider and input");
  }
  return {
    callbacks,
    input,
    handle,
    sendAudio,
    handleBargeIn,
    writeOutput,
    clearOutput,
    startBargeInMonitor,
    consultAgent,
    handleToolCall,
  };
}

afterEach(() => vi.useRealTimers());

describe("speech provider custom input and delegation contracts", () => {
  it.for([undefined, 0, 0.25] as const)(
    "keeps PCM playback protected with a %s-second configured tail",
    async (tailSeconds) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const fixture = await createLiveFixture({
        continuous: false,
        isolated: false,
        echoSuppressionTailSeconds: tailSeconds,
      });
      try {
        const speech = Buffer.alloc(960, 1); // 20ms at 24kHz PCM16.
        fixture.callbacks.onAudio(speech);
        fixture.input(speech);
        expect(fixture.sendAudio).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(19 + (tailSeconds ?? 3) * 1_000);
        fixture.input(speech);
        expect(fixture.sendAudio).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        fixture.input(speech);
        expect(fixture.sendAudio).toHaveBeenCalledExactlyOnceWith(speech);
      } finally {
        await fixture.handle.stop();
      }
    },
  );

  it("projects rich host consult results to the provider's text-only callback contract", async () => {
    const rich: RealtimeVoiceAgentConsultResult = {
      text: "The answer.",
      delivered: true,
      yielded: true,
      utterances: [
        {
          text: "The answer.",
          speech: {
            tagged: true,
            text: "The answer.",
            expression: { parts: [{ text: "The answer." }] },
          },
          localServiceAdmission: {
            generation: "synthetic-worker",
            signal: new AbortController().signal,
          },
          expectedSpeechSelection: {
            provider: "example",
            model: "prepared-model",
            voice: "prepared-voice",
          },
        },
      ],
    };
    const fixture = await createLiveFixture({ consultAgent: async () => rich });
    try {
      const consult = fixture.callbacks.runAgentConsult;
      if (!consult) {
        throw new Error("Expected native agent delegation");
      }
      const result = await consult({ prompt: "Check the project" });
      expect(result).toEqual({ text: rich.text });
      expect(Object.keys(result)).toEqual(["text"]);
      expect(result).not.toBe(rich);
      expect(fixture.consultAgent).toHaveBeenCalledOnce();
    } finally {
      await fixture.handle.stop();
    }
  });
});
