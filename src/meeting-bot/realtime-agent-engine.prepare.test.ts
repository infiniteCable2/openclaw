import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import {
  prepareMeetingAgentRealtimeEngine,
  startMeetingAgentRealtimeEngine,
} from "./realtime-agent-engine.js";

function createProvider(prepareSession: RealtimeTranscriptionProviderPlugin["prepareSession"]) {
  return {
    id: "prepared-stt",
    label: "Prepared STT",
    isConfigured: () => true,
    prepareSession,
    createSession: vi.fn(),
  } satisfies RealtimeTranscriptionProviderPlugin;
}

function createRuntime(
  prepareTextToSpeechTelephony: PluginRuntime["tts"]["prepareTextToSpeechTelephony"],
) {
  return {
    tts: { prepareTextToSpeechTelephony },
  } as unknown as PluginRuntime;
}

const config = {
  chrome: { audioFormat: "pcm16-24khz" as const },
  realtime: {
    strategy: "agent" as const,
    agentId: "reader",
    transcriptionProvider: "prepared-stt",
    providers: { "prepared-stt": {} },
  },
};

describe("prepareMeetingAgentRealtimeEngine", () => {
  it("prepares both speech directions and retains their resources", async () => {
    const releaseStt = vi.fn();
    const releaseTts = vi.fn(async () => undefined);
    const prepareSession = vi.fn(async () => ({ release: releaseStt }));
    const prepareTts = vi.fn(async () => ({ success: true, release: releaseTts }));
    const signal = new AbortController().signal;

    const preparation = await prepareMeetingAgentRealtimeEngine({
      config,
      fullConfig: {} as never,
      runtime: createRuntime(prepareTts),
      providers: [createProvider(prepareSession)],
      ttsContext: { agentId: "reader", channelId: "matrix", accountId: "personal" },
      signal,
    });

    expect(prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerConfig: {}, signal: expect.any(AbortSignal) }),
    );
    expect(prepareTts).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "reader",
        channelId: "matrix",
        accountId: "personal",
        signal: expect.any(AbortSignal),
      }),
    );
    await preparation.release();
    await preparation.release();
    expect(releaseStt).toHaveBeenCalledOnce();
    expect(releaseTts).toHaveBeenCalledOnce();
  });

  it("releases a prepared STT provider when TTS readiness fails", async () => {
    const releaseStt = vi.fn();
    const provider = createProvider(vi.fn(async () => ({ release: releaseStt })));

    await expect(
      prepareMeetingAgentRealtimeEngine({
        config,
        fullConfig: {} as never,
        runtime: createRuntime(vi.fn(async () => ({ success: false, error: "not ready" }))),
        providers: [provider],
      }),
    ).rejects.toThrow("not ready");
    expect(releaseStt).toHaveBeenCalledOnce();
  });

  it("keeps overlapping call preparations independently leased", async () => {
    const releaseStt = [vi.fn(), vi.fn()];
    const releaseTts = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    let sttCall = 0;
    let ttsCall = 0;
    const provider = createProvider(
      vi.fn(async () => ({ release: releaseStt[sttCall++] as () => void })),
    );
    const runtime = createRuntime(
      vi.fn(async () => ({ success: true, release: releaseTts[ttsCall++] })),
    );

    const [first, second] = await Promise.all([
      prepareMeetingAgentRealtimeEngine({
        config,
        fullConfig: {} as never,
        runtime,
        providers: [provider],
      }),
      prepareMeetingAgentRealtimeEngine({
        config,
        fullConfig: {} as never,
        runtime,
        providers: [provider],
      }),
    ]);

    await first.release();
    expect(releaseStt[0]).toHaveBeenCalledOnce();
    expect(releaseTts[0]).toHaveBeenCalledOnce();
    expect(releaseStt[1]).not.toHaveBeenCalled();
    expect(releaseTts[1]).not.toHaveBeenCalled();

    await second.release();
    expect(releaseStt[1]).toHaveBeenCalledOnce();
    expect(releaseTts[1]).toHaveBeenCalledOnce();
  });
});

describe("startMeetingAgentRealtimeEngine streaming output", () => {
  it("writes ordered TTS segments as they arrive and releases the stream", async () => {
    const release = vi.fn(async () => undefined);
    const beginOutput = vi.fn();
    const writes: Buffer[] = [];
    const provider = createProvider(undefined);
    provider.createSession.mockReturnValue({
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: () => true,
    });
    const handle = await startMeetingAgentRealtimeEngine({
      config,
      fullConfig: {} as never,
      runtime: {
        tts: {
          streamTextToSpeechTelephony: vi.fn(async () => ({
            success: true,
            audioStream: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Uint8Array.from([1, 0, 2, 0]));
                controller.enqueue(Uint8Array.from([3, 0, 4, 0]));
                controller.close();
              },
            }),
            outputFormat: "pcm",
            sampleRate: 24_000,
            release,
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
        beginOutput,
        writeOutput: vi.fn(async (audio: Buffer) => {
          writes.push(Buffer.from(audio));
        }),
        clearOutput: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providers: [provider],
      consultAgent: vi.fn(async () => ({ text: "unused" })),
    });

    handle.speak("Zwei frühe Segmente.");
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0])]);
    expect(beginOutput).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await handle.stop();
  });

  it("cancels synthesis and clears queued playback when the caller starts speaking", async () => {
    const streamCancelled = vi.fn();
    const clearOutput = vi.fn(async () => undefined);
    let onSpeechStart: (() => void) | undefined;
    const provider = createProvider(undefined);
    provider.createSession.mockImplementation((params) => {
      onSpeechStart = params.onSpeechStart;
      return {
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        close: vi.fn(),
        isConnected: () => true,
      };
    });
    const writeOutput = vi.fn(async () => undefined);
    const handle = await startMeetingAgentRealtimeEngine({
      config,
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

    await vi.waitFor(() => {
      expect(streamCancelled).toHaveBeenCalledOnce();
      expect(clearOutput).toHaveBeenCalledOnce();
    });
    await handle.stop();
  });
});
