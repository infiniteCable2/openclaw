import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  convertMeetingTtsAudioForBridge,
  createLocalMeetingRealtimeAudioTransport,
  startMeetingAgentRealtimeEngine,
} from "openclaw/plugin-sdk/meeting-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "../config.js";
import { createTestMeetRealtimeAudioTransport } from "./fixtures.test-helpers.js";
import { noopLogger } from "./plugin-harness.js";
import {
  createGoogleMeetTestEngineBindings,
  createTestMeetTranscriptionProvider,
  createTestMeetVoiceProvider,
  startTestNodeRealtimeAudioBridge,
} from "./realtime-engine.test-helpers.js";

export function registerGoogleMeetRealtimeAudioTests() {
  it("uses realtime transcription plus regular TTS in Chrome agent mode", async () => {
    vi.useFakeTimers();
    const { provider, requireRequest, sendAudio } = createTestMeetTranscriptionProvider();
    const { transport, deliverInput, writeOutput } = createTestMeetRealtimeAudioTransport();
    const runtime = createTestPluginApi().runtime;
    runtime.tts = {
      ...runtime.tts,
      streamTextToSpeechTelephony: vi.fn(async () => ({
        success: true,
        audioStream: new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 0, 2, 0]));
            controller.close();
          },
        }),
        sampleRate: 24_000,
        provider: "elevenlabs",
        providerModel: "eleven_multilingual_v2",
        providerVoice: "pMsXgVXv3BLzUgSXRplE",
        outputFormat: "pcm16",
      })),
    };
    const consultAgent = vi.fn(async () => ({ text: "Use the Portugal launch data." }));
    const turnEnded = createDeferred<void>();
    const engineParams = {
      config: resolveGoogleMeetConfig({
        realtime: { provider: "openai", agentId: "jay", introMessage: "" },
      }),
      fullConfig: {},
      runtime,
      logger: noopLogger,
    };
    const handle = await startMeetingAgentRealtimeEngine({
      ...engineParams,
      platform: createGoogleMeetTestEngineBindings(engineParams).platform,
      consultAgent,
      meetingSessionId: "meet-1",
      transport,
      providers: [provider],
      onTalkEvent: (event) => {
        if (event.type === "turn.ended") {
          turnEnded.resolve();
        }
      },
    });
    const callbacks = requireRequest();

    expect(noopLogger.info).toHaveBeenCalledWith(
      "[google-meet] agent audio bridge starting: transcriptionProvider=openai transcriptionModel=gpt-4o-transcribe tts=telephony audioFormat=pcm16-24khz",
    );
    deliverInput(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]));
    const timersBeforeTranscript = vi.getTimerCount();
    callbacks.onTranscript?.("Please summarize the launch.");
    expect(vi.getTimerCount()).toBe(timersBeforeTranscript + 1);
    // SDK background work can own an earlier timer; cross the actual talkback debounce.
    await vi.advanceTimersByTimeAsync(900);
    expect(consultAgent).toHaveBeenCalledTimes(1);
    expect(runtime.tts.streamTextToSpeechTelephony).toHaveBeenCalledTimes(1);
    expect(writeOutput).toHaveBeenCalledTimes(1);
    await turnEnded.promise;

    expect(sendAudio).toHaveBeenCalledTimes(1);
    const audioChunk = sendAudio.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(audioChunk)).toBe(true);
    expect(audioChunk?.byteLength).toBeGreaterThan(0);
    expect(consultAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ question: "Please summarize the launch." }),
        meetingSessionId: "meet-1",
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(runtime.tts.streamTextToSpeechTelephony).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Use the Portugal launch data.",
        cfg: {},
        agentId: "jay",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(noopLogger.info).toHaveBeenCalledWith(
      "[google-meet] agent TTS: provider=elevenlabs model=eleven_multilingual_v2 voice=pMsXgVXv3BLzUgSXRplE outputFormat=pcm16 sampleRate=24000",
    );
    expect(writeOutput).toHaveBeenCalledWith(Buffer.from([1, 0, 2, 0]));
    const health = handle.getHealth();
    expect(health.providerConnected).toBe(true);
    expect(health.lastInputBytes).toBe(8);
    expect(health.lastOutputBytes).toBe(4);
    expect(health.realtimeTranscriptLines).toBe(2);
    expect(health.lastRealtimeTranscriptRole).toBe("assistant");
    const talkEventTypes = health.recentTalkEvents?.map((event) => event.type) ?? [];
    expect(talkEventTypes).toEqual([
      "session.started",
      "session.ready",
      "turn.started",
      "input.audio.delta",
      "input.audio.committed",
      "transcript.done",
      "output.text.done",
      "output.audio.started",
      "output.audio.delta",
      "output.audio.done",
      "turn.ended",
    ]);
    expect(talkEventTypes.indexOf("output.text.done")).toBeLessThan(
      talkEventTypes.indexOf("output.audio.started"),
    );
    await handle.stop();
  });

  it("closes output and turn lifecycle when agent audio delivery fails", async () => {
    vi.useFakeTimers();
    const { provider, requireRequest } = createTestMeetTranscriptionProvider();
    const { transport, writeOutput } = createTestMeetRealtimeAudioTransport();
    writeOutput.mockRejectedValueOnce(new Error("audio sink failed"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = createTestPluginApi().runtime;
    runtime.tts = {
      ...runtime.tts,
      streamTextToSpeechTelephony: vi.fn(async () => ({
        success: true,
        audioStream: new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 0, 2, 0]));
            controller.close();
          },
        }),
        sampleRate: 24_000,
        provider: "test",
        outputFormat: "pcm16",
      })),
    };
    const handle = await startMeetingAgentRealtimeEngine({
      config: resolveGoogleMeetConfig({
        realtime: { provider: "openai", agentId: "jay", introMessage: "" },
      }),
      fullConfig: {},
      runtime,
      platform: {
        displayName: "Google Meet",
        logScope: "[google-meet]",
        sessionIdPrefix: "google-meet",
      },
      meetingSessionId: "meet-output-failure",
      transport,
      logger,
      providers: [provider],
      consultAgent: async () => ({ text: "Answer from the agent." }),
    });
    const callbacks = requireRequest();

    callbacks.onTranscript?.("Question from the meeting.");
    await vi.advanceTimersByTimeAsync(900);
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith("[google-meet] agent TTS failed: audio sink failed");
    });

    expect(handle.getHealth().recentTalkEvents?.map((event) => event.type)).toEqual([
      "session.started",
      "session.ready",
      "turn.started",
      "input.audio.committed",
      "transcript.done",
      "output.text.done",
      "output.audio.started",
      "output.audio.delta",
      "output.audio.done",
      "turn.ended",
    ]);
    await handle.stop();
  });

  it("aborts agent engine startup when the transport already failed", async () => {
    const createSession = vi.fn();
    const { provider } = createTestMeetTranscriptionProvider({ createSession });
    const stop = vi.fn(async () => {});
    const config = resolveGoogleMeetConfig({
      realtime: { provider: "openai", agentId: "jay", introMessage: "" },
    });
    const engineParams = {
      config,
      fullConfig: {},
      runtime: createTestPluginApi().runtime,
      logger: noopLogger,
    };
    await expect(
      startMeetingAgentRealtimeEngine({
        ...engineParams,
        platform: createGoogleMeetTestEngineBindings(engineParams).platform,
        consultAgent: async () => ({ text: "" }),
        meetingSessionId: "meet-fatal",
        providers: [provider],
        transport: {
          // Pre-registration fatal replays synchronously; startup must abort before createSession.
          onFatal: (handler) => handler(),
          startInput: vi.fn(),
          stop,
          writeOutput: vi.fn(async () => {}),
          clearOutput: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        },
      }),
    ).rejects.toThrow("Google Meet audio transport stopped during provider setup");
    expect(createSession).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it("stops the Chrome agent audio bridge when child stdio streams error", async () => {
    const { provider, sttSession } = createTestMeetTranscriptionProvider();
    const inputStdout = new PassThrough();
    const inputStderr = new PassThrough();
    const outputStderr = new PassThrough();
    const outputStdin = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    type BridgeProcess = ReturnType<
      NonNullable<Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]["spawn"]>
    >;
    function bridgeProcess(stdio: Pick<BridgeProcess, "stdin" | "stdout" | "stderr">) {
      const kill = vi.fn((signal?: NodeJS.Signals) => {
        child.signalCode = signal ?? "SIGTERM";
        return true;
      });
      const child: BridgeProcess = Object.assign(new EventEmitter(), stdio, {
        exitCode: null,
        signalCode: null,
        kill,
      });
      return { child, kill };
    }
    const { child: outputProcess, kill: outputKill } = bridgeProcess({
      stdin: outputStdin,
      stdout: null,
      stderr: outputStderr,
    });
    const { child: inputProcess, kill: inputKill } = bridgeProcess({
      stdin: null,
      stdout: inputStdout,
      stderr: inputStderr,
    });
    const spawnMock = vi.fn<
      NonNullable<Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]["spawn"]>
    >((command) => (command === "capture-meet" ? inputProcess : outputProcess));
    const config = resolveGoogleMeetConfig({
      realtime: { provider: "openai", agentId: "jay", introMessage: "" },
    });
    const transport = createLocalMeetingRealtimeAudioTransport({
      inputCommand: ["capture-meet"],
      outputCommand: ["play-meet"],
      bargeInRmsThreshold: config.chrome.bargeInRmsThreshold,
      bargeInPeakThreshold: config.chrome.bargeInPeakThreshold,
      bargeInCooldownMs: config.chrome.bargeInCooldownMs,
      logger: noopLogger,
      logScope: "[google-meet]",
      spawn: spawnMock,
    });
    const engineParams = {
      config,
      fullConfig: {},
      runtime: createTestPluginApi().runtime,
      logger: noopLogger,
    };
    const handle = await startMeetingAgentRealtimeEngine({
      ...engineParams,
      platform: createGoogleMeetTestEngineBindings(engineParams).platform,
      consultAgent: async () => ({ text: "" }),
      meetingSessionId: "meet-1",
      transport,
      providers: [provider],
    });

    expect(() => inputStdout.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(noopLogger.warn).toHaveBeenCalledWith(
      "[google-meet] audio input command stdout failed: EPIPE",
    );
    await handle.stop();
    expect(handle.getHealth().bridgeClosed).toBe(true);
    expect(sttSession.close).toHaveBeenCalled();
    expect(inputKill).toHaveBeenCalledWith("SIGTERM");
    expect(outputKill).toHaveBeenCalledWith("SIGTERM");

    expect(() => inputStderr.emit("error", new Error("stderr EPIPE"))).not.toThrow();
    expect(() => outputStderr.emit("error", new Error("output EPIPE"))).not.toThrow();
    expect(noopLogger.warn).toHaveBeenCalledWith(
      "[google-meet] audio input command stderr failed: stderr EPIPE",
    );
    expect(noopLogger.warn).toHaveBeenCalledWith(
      "[google-meet] audio output command stderr failed: output EPIPE",
    );
  });

  it("preserves telephony TTS output formats when routing Google Meet agent audio", () => {
    const ulaw = Buffer.from([0xff, 0x7f, 0x00]);
    const pcmBridgeConfig = resolveGoogleMeetConfig({ chrome: { audioFormat: "pcm16-24khz" } });
    const ulawBridgeConfig = resolveGoogleMeetConfig({ chrome: { audioFormat: "g711-ulaw-8khz" } });

    expect(
      convertMeetingTtsAudioForBridge(
        ulaw,
        8_000,
        ulawBridgeConfig.chrome.audioFormat,
        "raw-8khz-8bit-mono-mulaw",
        "Google Meet",
      ),
    ).toEqual(ulaw);
    const pcmForMeet = convertMeetingTtsAudioForBridge(
      ulaw,
      8_000,
      pcmBridgeConfig.chrome.audioFormat,
      "ulaw_8000",
      "Google Meet",
    );
    expect(pcmForMeet.byteLength).toBe(18);
    expect(pcmForMeet).not.toEqual(ulaw);
    expect(() =>
      convertMeetingTtsAudioForBridge(
        Buffer.from([1, 2, 3]),
        8_000,
        pcmBridgeConfig.chrome.audioFormat,
        "mp3",
        "Google Meet",
      ),
    ).toThrow("Unsupported telephony TTS output format");
  });

  it("pipes paired-node audio and clears playback through the realtime provider", async () => {
    const { bridge, provider, requireRequest, sendAudio } = createTestMeetVoiceProvider();
    let pullCount = 0;
    const idlePull = createDeferred<{ bridgeId: string }>();
    const runtime = {
      nodes: {
        invoke: vi.fn(async ({ params }: { params?: { action?: string; base64?: string } }) => {
          if (params?.action === "pullAudio") {
            pullCount += 1;
            return pullCount === 1
              ? { bridgeId: "bridge-1", base64: Buffer.from([9, 8, 7]).toString("base64") }
              : await idlePull.promise;
          }
          if (params?.action === "stop") {
            idlePull.resolve({ bridgeId: "bridge-1" });
          }
          return { ok: true };
        }),
      },
    };
    const handle = await startTestNodeRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { strategy: "bidi", provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig: {} as never,
      runtime: runtime as never,
      meetingSessionId: "meet-1",
      nodeId: "node-1",
      bridgeId: "bridge-1",
      logger: noopLogger,
      providers: [provider],
    });
    try {
      const callbacks = requireRequest();
      await vi.waitFor(() => {
        expect(sendAudio).toHaveBeenCalledWith(Buffer.from([9, 8, 7]));
      });
      callbacks.onAudio(Buffer.from([1, 2, 3]));
      await vi.waitFor(() => {
        expect(runtime.nodes.invoke).toHaveBeenCalledWith({
          nodeId: "node-1",
          command: "googlemeet.chrome",
          params: {
            action: "pushAudio",
            bridgeId: "bridge-1",
            base64: Buffer.from([1, 2, 3]).toString("base64"),
            outputGeneration: 0,
          },
          timeoutMs: 5_000,
        });
      });
      callbacks.onClearAudio();
      await vi.waitFor(() => {
        expect(runtime.nodes.invoke).toHaveBeenCalledWith({
          nodeId: "node-1",
          command: "googlemeet.chrome",
          params: { action: "clearAudio", bridgeId: "bridge-1", outputGeneration: 1 },
          timeoutMs: 5_000,
        });
      });
      expect(handle.getHealth()).toMatchObject({
        audioInputActive: true,
        audioOutputActive: true,
        lastInputBytes: 3,
        lastOutputBytes: 3,
        clearCount: 1,
      });
    } finally {
      await handle.stop();
      idlePull.resolve({ bridgeId: "bridge-1" });
    }
    expect(bridge.close).toHaveBeenCalledOnce();
    expect(runtime.nodes.invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "googlemeet.chrome",
      params: { action: "stop", bridgeId: "bridge-1" },
      timeoutMs: 5_000,
    });
  });
}
