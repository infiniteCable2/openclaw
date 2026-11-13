import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { playSpeechGreeting, prepareSpeechGreeting } from "./greeting.js";
import type { SpeechSessionPreparation } from "./preparation.js";
import type { SpeechAgentConsultParams } from "./types.js";

const logs = vi.hoisted(() => ({ warn: vi.fn() }));
// mock-isolation: Retain the logging owner; capture only this module's safe failure diagnostics.
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      return name === "talk/greeting" ? { ...logger, warn: logs.warn } : logger;
    },
  };
});

describe("meeting agent greeting preparation", () => {
  function greetingParams(runtime: PluginRuntime, signal = new AbortController().signal) {
    return {
      cfg: {},
      runtime,
      consultAgent: async () => ({ text: "Hello, caller!" }),
      sessionId: "call-cleanup",
      callerId: "@owner:example.test",
      prompt: "Greet briefly.",
      timeZone: "UTC",
      audioFormat: "pcm16-24khz" as const,
      signal,
    };
  }

  it("uses admitted identity and local time, then prepares speech without playback", async () => {
    const consultAgent = vi.fn(async (_request: SpeechAgentConsultParams) => ({
      text: "Guten Morgen, Alex!",
    }));
    const tts = vi.fn(async () => ({
      success: true,
      sampleRate: 24_000,
      outputFormat: "pcm" as const,
      audioStream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 0, 2, 0]));
          controller.close();
        },
      }),
    }));
    const greeting = await prepareSpeechGreeting({
      cfg: {},
      runtime: { tts: { streamTextToSpeechTelephony: tts } } as unknown as PluginRuntime,
      consultAgent,
      sessionId: "call-1",
      requesterSessionKey: "agent:example:matrix:direct:owner",
      callerId: "@owner:example.test",
      prompt: "Greet briefly.",
      timeZone: "Europe/Berlin",
      audioFormat: "pcm16-24khz",
      signal: new AbortController().signal,
      now: new Date("2026-09-29T07:00:00Z"),
    });
    expect(consultAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "call-1",
        inputId: expect.any(String),
        purpose: "greeting",
        speechExpressionCaptureOnly: true,
        requesterSessionKey: "agent:example:matrix:direct:owner",
        args: expect.objectContaining({
          question: expect.stringContaining("09:00"),
        }),
      }),
    );
    expect(JSON.stringify(consultAgent.mock.calls[0]?.[0].args)).toContain("@owner:example.test");
    expect(tts).toHaveBeenCalledWith(expect.objectContaining({ text: "Guten Morgen, Alex!" }));
    expect(greeting.text).toBe("Guten Morgen, Alex!");
    expect(greeting.audio.byteLength).toBeGreaterThan(0);
  });

  it("reports a consult failure without losing its cause or exposing its text", async () => {
    logs.warn.mockClear();
    const failure = new Error("synthetic private caller content");
    await expect(
      prepareSpeechGreeting({
        ...greetingParams({} as PluginRuntime),
        consultAgent: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(logs.warn).toHaveBeenCalledWith(
      "Speech greeting preparation failed",
      expect.objectContaining({
        phase: "consult",
        rawErrorHash: expect.stringMatching(/^sha256:/),
      }),
    );
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(failure.message);
  });

  it.each([
    { starts: false, accepts: true, interrupted: false, publicationFails: false },
    { starts: true, accepts: false, interrupted: false, publicationFails: false },
    { starts: true, accepts: true, interrupted: false, publicationFails: false },
    { starts: true, accepts: true, interrupted: true, publicationFails: false },
    { starts: true, accepts: true, interrupted: false, publicationFails: true },
  ])(
    "records only handed-off greeting audio: %j",
    async ({ starts, accepts, interrupted, publicationFails }) => {
      vi.useFakeTimers();
      try {
        let current = true;
        const recordSubmitted = vi.fn(async () => {
          if (publicationFails) {
            throw new Error("Synthetic persistence failure");
          }
        });
        const endTurn = vi.fn();
        const params = {
          greeting: { text: "Hello!", audio: Buffer.from([0, 0]), recordSubmitted },
          transport: {},
          harness: {
            ensureTurn: () => "greeting",
            emit: vi.fn(),
            recordTranscript: () => ({}),
            finishOutputAudio: vi.fn(),
            endTurn,
          },
          sessionId: "example-call",
          activeTtsAborts: new Set<AbortController>(),
          isCurrent: () => current,
          canStart: () => starts,
          onStarted: vi.fn(),
          writeOutputAudio: vi.fn(async () => {
            current = !interrupted;
            return accepts;
          }),
        } as unknown as Parameters<typeof playSpeechGreeting>[0];
        const playing = playSpeechGreeting(params);
        await vi.advanceTimersByTimeAsync(150);
        await playing;
        if (starts && accepts) {
          expect(recordSubmitted).toHaveBeenCalledExactlyOnceWith({
            audioDelivery: interrupted ? "interrupted" : "submitted",
          });
        } else {
          expect(recordSubmitted).not.toHaveBeenCalled();
        }
        expect(endTurn).toHaveBeenCalledTimes(starts && accepts && !interrupted ? 1 : 0);
        expect(params.activeTtsAborts.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([true, false])(
    "retains greeting worker admission with expression=%s",
    async (expressive) => {
      const text = "Hello!";
      const expression = { emotion: "joyful", parts: [{ text }] };
      const expectedSpeechSelection = {
        provider: "example",
        model: "prepared-model",
        voice: "prepared-voice",
      };
      const localServiceAdmission = {
        generation: "synthetic-worker",
        signal: new AbortController().signal,
      };
      const tts = vi.fn<PluginRuntime["tts"]["streamTextToSpeechTelephony"]>(async () => ({
        success: true,
        sampleRate: 24_000,
        outputFormat: "pcm",
        audioStream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 0, 2, 0]));
            controller.close();
          },
        }),
      }));
      await prepareSpeechGreeting({
        ...greetingParams({
          tts: { streamTextToSpeechTelephony: tts },
        } as unknown as PluginRuntime),
        consultAgent: async () => ({
          text,
          utterances: [
            {
              text,
              ...(expressive ? { speech: { tagged: true as const, text, expression } } : {}),
              localServiceAdmission,
              expectedSpeechSelection,
            },
          ],
        }),
      });
      expect(tts).toHaveBeenCalledWith(
        expect.objectContaining({
          text,
          ...(expressive ? { overrides: { expression } } : {}),
          localServiceAdmission,
          expectedSpeechSelection,
        }),
      );
      expect(tts.mock.calls[0]?.[0]).not.toHaveProperty("expression");
      if (!expressive) {
        expect(tts.mock.calls[0]?.[0]).not.toHaveProperty("overrides");
      }
    },
  );

  it("releases a stalled greeting stream when the call is aborted", async () => {
    let startedRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      startedRead = resolve;
    });
    const release = vi.fn(async () => {});
    const audioStream = new ReadableStream<Uint8Array>(
      {
        pull() {
          startedRead();
        },
      },
      { highWaterMark: 0 },
    );
    const abort = new AbortController();
    const pending = prepareSpeechGreeting({
      cfg: {},
      runtime: {
        tts: {
          streamTextToSpeechTelephony: async () => ({
            success: true,
            sampleRate: 24_000,
            outputFormat: "pcm",
            audioStream,
            release,
          }),
        },
      } as unknown as PluginRuntime,
      consultAgent: async () => ({ text: "Guten Tag!" }),
      sessionId: "call-2",
      callerId: "@owner:example.test",
      prompt: "Greet briefly.",
      timeZone: "Europe/Berlin",
      audioFormat: "pcm16-24khz",
      signal: abort.signal,
    });
    await reading;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("owns and cancels a stream acquired after its greeting deadline expired", async () => {
    const acquisition =
      Promise.withResolvers<
        Awaited<ReturnType<PluginRuntime["tts"]["streamTextToSpeechTelephony"]>>
      >();
    const started = Promise.withResolvers<void>();
    const release = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const abort = new AbortController();
    let owned: SpeechSessionPreparation | undefined;
    const pending = prepareSpeechGreeting({
      ...greetingParams(
        {
          tts: {
            streamTextToSpeechTelephony: () => {
              started.resolve();
              return acquisition.promise;
            },
          },
        } as unknown as PluginRuntime,
        abort.signal,
      ),
      onPreparation: (owner) => {
        owned = owner;
      },
    });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    expect(owned).toBeDefined();
    abort.abort();
    acquisition.resolve({
      success: true,
      sampleRate: 24_000,
      outputFormat: "pcm",
      audioStream: new ReadableStream<Uint8Array>({ cancel }),
      release,
    });
    await rejection;
    await owned!.release();
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("retains failed release ownership without replaying successful stream cleanup", async () => {
    const failure = new Error("synthetic greeting lease release failed");
    const release = vi.fn(async () => undefined).mockRejectedValueOnce(failure);
    const cancel = vi.fn(async () => undefined);
    let owned: SpeechSessionPreparation | undefined;
    await expect(
      prepareSpeechGreeting({
        ...greetingParams({
          tts: {
            streamTextToSpeechTelephony: async () => ({
              success: true,
              sampleRate: 24_000,
              outputFormat: "pcm",
              audioStream: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(Uint8Array.from([1, 0]));
                },
                pull(controller) {
                  controller.close();
                },
                cancel,
              }),
              release,
            }),
          },
        } as unknown as PluginRuntime),
        onPreparation: (owner) => {
          owned = owner;
        },
      }),
    ).rejects.toMatchObject({ errors: [failure] });
    // A consumed stream is already closed; release retries only the failed hold.
    expect(release).toHaveBeenCalledOnce();
    await owned!.release();
    await owned!.release();
    expect(release).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("retains both the synthesis error and cleanup error for an invalid acquired stream", async () => {
    const cleanupFailure = new Error("synthetic release failed");
    const release = vi.fn(async () => undefined).mockRejectedValueOnce(cleanupFailure);
    const cancel = vi.fn(async () => undefined);
    let owned: SpeechSessionPreparation | undefined;
    const error = await prepareSpeechGreeting({
      ...greetingParams({
        tts: {
          streamTextToSpeechTelephony: async () => ({
            success: false,
            error: "synthetic synthesis failed",
            audioStream: new ReadableStream<Uint8Array>({ cancel }),
            release,
          }),
        },
      } as unknown as PluginRuntime),
      onPreparation: (owner) => {
        owned = owner;
      },
    }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      errors: [
        expect.objectContaining({ message: "synthetic synthesis failed" }),
        expect.objectContaining({ errors: [cleanupFailure] }),
      ],
    });
    await owned!.release();
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("keeps the provider hold until failed reader cancellation is successfully retried", async () => {
    const cancelFailure = new Error("synthetic stream cancellation failed");
    const cancel = vi.fn(async () => undefined).mockRejectedValueOnce(cancelFailure);
    const release = vi.fn(async () => undefined);
    let owned: SpeechSessionPreparation | undefined;
    const error = await prepareSpeechGreeting({
      ...greetingParams({
        tts: {
          streamTextToSpeechTelephony: async () => ({
            success: false,
            error: "synthetic synthesis failed",
            audioStream: new ReadableStream<Uint8Array>({ cancel }),
            release,
          }),
        },
      } as unknown as PluginRuntime),
      onPreparation: (owner) => {
        owned = owner;
      },
    }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      errors: [expect.any(Error), expect.objectContaining({ errors: [cancelFailure] })],
    });
    expect(release).not.toHaveBeenCalled();
    // The next cancel observes the now-closed stream. Only then may its hold go.
    await owned!.release();
    expect(release).toHaveBeenCalledOnce();
    await owned!.release();
    expect(release).toHaveBeenCalledOnce();
  });
});
