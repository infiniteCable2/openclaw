import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
} from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { startSpeechRealtimeSession } from "./provider-session.js";
import { startSpeechSession } from "./session.js";
import type { SpeechRealtimeSessionHandle } from "./types.js";
import * as waitingAudio from "./waiting-audio.js";

describe("speech session failed-start ownership", () => {
  it.each(["waiting abort", "capture abort", "capture rejection", "capture stop"] as const)(
    "fences provider startup and joins capture ownership after %s",
    async (stage) => {
      const preparation = createDeferredCore<undefined>();
      const capture = createDeferredCore();
      const captureStarted = createDeferredCore();
      const captureStopped = createDeferredCore();
      const ownership = createDeferredCore<SpeechRealtimeSessionHandle>();
      const controller = new AbortController();
      const failure = new Error("synthetic startup interruption");
      const prepare = vi
        .spyOn(waitingAudio, "prepareSpeechWaitingAudio")
        .mockReturnValueOnce(preparation.promise);
      const connect = vi.fn(async () => undefined);
      const close = vi.fn();
      const startInput = vi.fn(() => {
        captureStarted.resolve();
        return capture.promise;
      });
      const stop = vi.fn(async () => {
        captureStopped.resolve();
      });
      const dispose = vi.fn(async () => undefined);
      const createSession = vi.fn(() => ({
        connect,
        close,
        sendAudio() {},
        isConnected: () => false,
      }));
      const provider: RealtimeTranscriptionProviderPlugin = {
        id: "test",
        label: "Test",
        isConfigured: () => true,
        createSession,
      };
      const startup = startSpeechSession({
        config: {
          audioFormat: "pcm16-24khz",
          transcriptionProvider: "test",
          providers: { test: {} },
        },
        fullConfig: {},
        runtime: {} as PluginRuntime,
        surface: { displayName: "Test", logScope: "test", sessionIdPrefix: "test" },
        sessionId: "interrupted-start",
        providers: [provider],
        signal: controller.signal,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        consultAgent: vi.fn(async () => ({ text: "unused" })),
        transport: {
          onFatal() {},
          startInput,
          stop,
          dispose,
          writeOutput: async () => undefined,
          clearOutput: async () => undefined,
        },
        onSession: (owner) => ownership.resolve(owner),
      });
      const rejected = expect(startup).rejects.toThrow(
        stage === "capture stop"
          ? "stopped during provider setup"
          : "synthetic startup interruption",
      );
      try {
        if (stage === "waiting abort") {
          controller.abort(failure);
          preparation.resolve(undefined);
          await rejected;
          expect(createSession).not.toHaveBeenCalled();
          expect(startInput).not.toHaveBeenCalled();
          expect(connect).not.toHaveBeenCalled();
          return;
        }
        preparation.resolve(undefined);
        await captureStarted.promise;
        const owner = await ownership.promise;
        let closing: Promise<void> | undefined;
        if (stage === "capture stop") {
          closing = owner.stop();
          await captureStopped.promise;
          // Stop may cancel capture acquisition but closure must wait for its receipt.
          expect(owner.getHealth().recentTalkEvents?.map((event) => event.type)).not.toContain(
            "session.closed",
          );
        } else if (stage === "capture abort") {
          controller.abort(failure);
        }
        if (stage === "capture rejection") {
          capture.reject(failure);
        } else {
          capture.resolve();
        }
        await rejected;
        await closing;
        expect(connect).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
        expect(stop).toHaveBeenCalledTimes(stage === "capture stop" ? 2 : 1);
        expect(owner.getHealth().recentTalkEvents?.map((event) => event.type)).not.toContain(
          "session.ready",
        );
        expect(
          owner.getHealth().recentTalkEvents?.filter((event) => event.type === "session.closed"),
        ).toHaveLength(1);
      } finally {
        preparation.resolve(undefined);
        capture.resolve();
        await startup.catch(() => undefined);
        prepare.mockRestore();
      }
    },
  );

  it.each(["transcription", "realtime"] as const)(
    "retains the %s teardown owner and retries only failed cleanup",
    async (strategy) => {
      const setupFailure = new Error("synthetic connect failure");
      const cleanupFailure = new Error("synthetic disposal failure");
      const connect = vi.fn(async () => {
        throw setupFailure;
      });
      const closeProvider = vi.fn();
      const stopTransport = vi.fn(async () => undefined);
      const disposeTransport = vi.fn(async () => undefined).mockRejectedValueOnce(cleanupFailure);
      let owned: SpeechRealtimeSessionHandle | undefined;
      const common = {
        config: {
          audioFormat: "pcm16-24khz" as const,
          provider: "test",
          transcriptionProvider: "test",
          providers: { test: {} },
        },
        fullConfig: {},
        runtime: {} as PluginRuntime,
        surface: { displayName: "Test", logScope: "test", sessionIdPrefix: "test" },
        sessionId: "failed-start",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        consultAgent: vi.fn(async () => ({ text: "unused" })),
        transport: {
          onFatal() {},
          startInput() {},
          stop: stopTransport,
          dispose: disposeTransport,
          writeOutput: async () => undefined,
          clearOutput: async () => undefined,
        },
        onSession: (handle: SpeechRealtimeSessionHandle) => {
          owned = handle;
        },
      };
      let startup: Promise<SpeechRealtimeSessionHandle>;
      if (strategy === "transcription") {
        const provider: RealtimeTranscriptionProviderPlugin = {
          id: "test",
          label: "Test",
          isConfigured: () => true,
          createSession: () => ({
            connect,
            close: closeProvider,
            sendAudio() {},
            isConnected: () => false,
          }),
        };
        startup = startSpeechSession({ ...common, providers: [provider] });
      } else {
        const provider: RealtimeVoiceProviderPlugin = {
          id: "test",
          label: "Test",
          isConfigured: () => true,
          createBridge: () => ({
            connect,
            close: closeProvider,
            acknowledgeMark() {},
            sendAudio() {},
            setMediaTimestamp() {},
            submitToolResult() {},
            isConnected: () => false,
          }),
        };
        startup = startSpeechRealtimeSession({
          ...common,
          config: { ...common.config, strategy: "bidi" },
          providers: [provider],
          tools: [],
          handleToolCall: vi.fn(async () => undefined),
        });
      }
      const failure = await startup.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toBe(setupFailure);
      expect(closeProvider).toHaveBeenCalledOnce();
      expect(stopTransport).toHaveBeenCalledOnce();
      expect(disposeTransport).toHaveBeenCalledOnce();
      const owner = expectDefined(owned, "Failed startup must retain its session cleanup owner");
      expect(owner.getHealth().recentTalkEvents?.map((event) => event.type)).not.toContain(
        "session.closed",
      );
      await owner.stop();
      await owner.stop();
      expect(connect).toHaveBeenCalledOnce();
      expect(closeProvider).toHaveBeenCalledOnce();
      expect(stopTransport).toHaveBeenCalledOnce();
      expect(disposeTransport).toHaveBeenCalledTimes(2);
      expect(
        owner.getHealth().recentTalkEvents?.filter((event) => event.type === "session.closed"),
      ).toHaveLength(1);
    },
  );
});
