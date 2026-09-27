import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";

describe("startMeetingAgentRealtimeEngine barge-in gate", () => {
  it("keeps playback after an unconfirmed onset and cancels on confirmed speech", async () => {
    const streamCancelled = vi.fn();
    const clearOutput = vi.fn(async () => undefined);
    const setOutputGate = vi.fn(async (_gate: "normal" | "duck" | "paused") => undefined);
    let onSpeechStart: (() => void) | undefined;
    let onSpeechActivity: Parameters<
      RealtimeTranscriptionProviderPlugin["createSession"]
    >[0]["onSpeechActivity"];
    let onProcessing: Parameters<
      RealtimeTranscriptionProviderPlugin["createSession"]
    >[0]["onProcessing"];
    const provider = {
      id: "prepared-stt",
      label: "Prepared STT",
      isConfigured: () => true,
      createSession: vi.fn((params) => {
        onSpeechStart = params.onSpeechStart;
        onSpeechActivity = params.onSpeechActivity;
        onProcessing = params.onProcessing;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          close: vi.fn(),
          isConnected: () => true,
        };
      }),
    } satisfies RealtimeTranscriptionProviderPlugin;
    const writeOutput = vi.fn(async () => undefined);
    const handle = await startMeetingAgentRealtimeEngine({
      config: {
        chrome: { audioFormat: "pcm16-24khz" },
        realtime: {
          strategy: "agent",
          agentId: "reader",
          transcriptionProvider: "prepared-stt",
          providers: { "prepared-stt": {} },
        },
      },
      fullConfig: {} as never,
      runtime: {
        tts: {
          streamTextToSpeechTelephony: vi.fn(async () => ({
            success: true,
            audioStream: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Uint8Array.from([1, 0, 2, 0]));
              },
              cancel: streamCancelled,
            }),
            outputFormat: "pcm",
            sampleRate: 24_000,
          })),
        },
      } as unknown as PluginRuntime,
      platform: {
        displayName: "Test meeting",
        logScope: "test meeting",
        sessionIdPrefix: "test-meeting",
      },
      meetingSessionId: "meeting-1",
      transport: {
        onFatal: vi.fn(),
        startInput: vi.fn(),
        writeOutput,
        clearOutput,
        setOutputGate,
        stop: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providers: [provider],
      consultAgent: vi.fn(async () => ({ text: "unused" })),
    });

    handle.speak("Diese Ausgabe wird unterbrochen.");
    await vi.waitFor(() => expect(writeOutput).toHaveBeenCalledOnce());
    onSpeechStart?.();
    onSpeechActivity?.({ utteranceId: "noise", state: "candidate" });
    onSpeechActivity?.({ utteranceId: "noise", state: "sustained" });
    onProcessing?.({ utteranceId: "noise", state: "started" });
    onSpeechActivity?.({ utteranceId: "noise", state: "rejected" });
    onProcessing?.({ utteranceId: "noise", state: "empty" });
    expect(setOutputGate.mock.calls.map(([gate]) => gate)).toEqual(["duck", "paused", "normal"]);
    expect(streamCancelled).not.toHaveBeenCalled();
    expect(clearOutput).not.toHaveBeenCalled();

    onSpeechStart?.();
    onSpeechActivity?.({ utteranceId: "speech", state: "candidate" });
    onSpeechActivity?.({ utteranceId: "speech", state: "sustained" });
    onProcessing?.({ utteranceId: "speech", state: "started" });
    onProcessing?.({ utteranceId: "speech", state: "speech-confirmed" });

    await vi.waitFor(() => {
      expect(streamCancelled).toHaveBeenCalledOnce();
      expect(clearOutput).toHaveBeenCalledOnce();
      expect(setOutputGate.mock.calls.map(([gate]) => gate)).toEqual([
        "duck",
        "paused",
        "normal",
        "duck",
        "paused",
        "normal",
      ]);
    });
    await handle.stop();
  });
});
