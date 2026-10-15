import { encodePngRgba } from "rastermill";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import type { RealtimeVoiceAgentControlResult } from "../agent-run-control.js";
import { startSpeechSession } from "./session.js";
import type { SpeechVideoFrame } from "./transport.js";
import type { SpeechAgentConsultParams, SpeechSessionHandle } from "./types.js";

const png = encodePngRgba(new Uint8Array([60, 40, 20, 255]), 1, 1);
const accepted: RealtimeVoiceAgentControlResult = {
  ok: true,
  queued: true,
  active: true,
  mode: "followup",
  sessionKey: "test",
  message: "Adopted",
  speak: true,
  show: true,
  suppress: false,
};

async function fixture(options: { pendingVideo?: boolean; runControl?: boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-01T12:00:00Z"));
  let callbacks!: Parameters<RealtimeTranscriptionProviderPlugin["createSession"]>[0];
  let onFrame!: (frame: SpeechVideoFrame) => void;
  const provider: RealtimeTranscriptionProviderPlugin = {
    id: "test-stt",
    label: "Test STT",
    isConfigured: () => true,
    transcriptGranularity: "utterance",
    createSession(params) {
      callbacks = params;
      return { connect: async () => {}, close() {}, sendAudio() {}, isConnected: () => true };
    },
  };
  const done = createDeferred<{ text: string; delivered?: boolean }>();
  const videoStarted = createDeferred<void>();
  const videoAcquired = createDeferred<void>();
  const owner = createDeferred<SpeechSessionHandle>();
  const control = vi.fn(async (_text: string, onAccepted?: (accepted: boolean) => void) => {
    onAccepted?.(true);
    return accepted;
  });
  const consultAgent = vi.fn(async (params: SpeechAgentConsultParams) => {
    if (options.runControl !== false) {
      params.onRunControl?.(control);
    }
    try {
      return await done.promise;
    } finally {
      params.onRunControl?.(undefined);
    }
  });
  const stopTransport = vi.fn(async () => {});
  const disposeTransport = vi.fn(async () => {});
  const starting = startSpeechSession({
    config: {
      audioFormat: "pcm16-24khz",
      transcriptionProvider: provider.id,
      providers: { [provider.id]: {} },
      video: { enabled: true, preview: { profile: "source" }, intervalMs: 250 },
    },
    fullConfig: {},
    runtime: {} as PluginRuntime,
    surface: { displayName: "Test", logScope: "test", sessionIdPrefix: "test" },
    sessionId: "video-test",
    providers: [provider],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onSession: (handle) => owner.resolve(handle),
    consultAgent,
    transport: {
      onFatal() {},
      startInput() {},
      startVideoInput(handler) {
        onFrame = handler;
        videoStarted.resolve();
        return options.pendingVideo ? videoAcquired.promise : undefined;
      },
      inputAudioIsolated: true,
      supportsFullDuplexInput: true,
      stop: stopTransport,
      dispose: disposeTransport,
      clearOutput: async () => {},
      writeOutput: async () => {},
    },
  });
  const handle = await owner.promise;
  await videoStarted.promise;
  if (!options.pendingVideo) {
    await starting;
  }
  return {
    handle,
    starting,
    videoAcquired,
    done,
    control,
    consultAgent,
    stopTransport,
    disposeTransport,
    callbacks,
    frame: () => onFrame({ data: png, mimeType: "image/png", timestampMs: Date.now() }),
    say: (text: string, utteranceId: string) => callbacks.onTranscript?.(text, { utteranceId }),
    onset: (utteranceId: string) =>
      callbacks.onSpeechActivity?.({ state: "candidate", utteranceId }),
    drain: () => vi.advanceTimersByTimeAsync(0),
  };
}

describe("speech session native video admission", () => {
  afterEach(() => vi.useRealTimers());

  it("attaches the current utterance's frames to the initial native consult", async () => {
    const f = await fixture();
    try {
      f.onset("first");
      f.frame();
      f.say("What is visible?", "first");
      await f.drain();
      expect(f.consultAgent).toHaveBeenCalledOnce();
      expect(f.consultAgent.mock.calls[0]?.[0]).toMatchObject({
        args: { question: "What is visible?", context: expect.stringContaining("Video frames") },
        images: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
      });
    } finally {
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it("steers a subsequent utterance with its own frame attachments through the same native owner", async () => {
    const f = await fixture();
    try {
      f.onset("first");
      f.frame();
      f.say("Look at this.", "first");
      await f.drain();
      await vi.advanceTimersByTimeAsync(1000);
      f.onset("next");
      f.frame();
      f.say("Now look here too.", "next");
      await f.drain();
      expect(f.consultAgent).toHaveBeenCalledOnce();
      expect(f.control).toHaveBeenCalledWith(
        expect.stringContaining("Now look here too."),
        expect.any(Function),
        expect.objectContaining({
          images: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
        }),
      );
    } finally {
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it("discards a queued unadopted input when the session closes", async () => {
    const f = await fixture({ runControl: false });
    try {
      f.say("First request.", "first");
      await f.drain();
      await vi.advanceTimersByTimeAsync(1000);
      f.onset("next");
      f.frame();
      f.say("Queued request.", "next");
      await f.drain();
      await f.handle.stop();
      f.done.resolve({ text: "" });
      await f.drain();
      f.frame();
      f.say("Too late.", "late");
      await f.drain();
      expect(f.consultAgent).toHaveBeenCalledOnce();
      expect(f.disposeTransport).toHaveBeenCalledOnce();
    } finally {
      f.done.resolve({ text: "" });
      await f.handle.stop();
    }
  });

  it("joins a pending video acquisition before disposal and stops its late capture", async () => {
    const f = await fixture({ pendingVideo: true });
    const rejected = expect(f.starting).rejects.toThrow("stopped during provider setup");
    try {
      const closing = f.handle.stop();
      await f.drain();
      expect(f.disposeTransport).not.toHaveBeenCalled();
      f.videoAcquired.resolve();
      await rejected;
      await closing;
      expect(f.stopTransport).toHaveBeenCalledTimes(2);
      expect(f.disposeTransport).toHaveBeenCalledOnce();
    } finally {
      f.videoAcquired.resolve();
      f.done.resolve({ text: "" });
      await f.starting.catch(() => undefined);
      await f.handle.stop();
    }
  });
});
