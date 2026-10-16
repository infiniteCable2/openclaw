import { ok } from "@openclaw/normalization-core/result";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest, MediaUnderstandingProvider } from "./types.js";

describe("native media transcription cancellation", () => {
  it.each(["context", "api-key"] as const)(
    "propagates cancellation through %s execution, joins it, and never tries another provider",
    async (kind) => {
      await withAudioFixture("openclaw-audio-cancellation", async ({ ctx, media, cache }) => {
        const controller = new AbortController();
        const entered = createDeferred();
        const released = createDeferred();
        const completed = vi.fn();
        const fallback = vi.fn(async () => ({ text: "Must not receive this recording" }));
        const execute = vi.fn(
          async (request: Pick<AudioTranscriptionRequest, "signal" | "timeoutMs">) => {
            expect(request.signal).toBe(controller.signal);
            expect(request.timeoutMs).toBe(1234);
            entered.resolve();
            await released.promise;
            request.signal?.throwIfAborted();
            return { text: "Late transcript" };
          },
        );
        const provider: MediaUnderstandingProvider = {
          id: "fixture",
          ...(kind === "context"
            ? {
                transcribeAudioWithContext: async (
                  request: Parameters<
                    NonNullable<MediaUnderstandingProvider["transcribeAudioWithContext"]>
                  >[0],
                ) => ok(await execute(request)),
              }
            : { transcribeAudio: execute }),
        };
        const operation = runCapability({
          capability: "audio",
          cfg: {
            models: {
              providers: {
                fixture: {
                  apiKey: "synthetic-test-key",
                  baseUrl: "https://example.invalid",
                  models: [],
                },
              },
            },
            tools: {
              media: {
                models: [
                  {
                    provider: "fixture",
                    model: "fixture-stt",
                    timeoutSeconds: 20,
                    capabilities: ["audio"],
                  },
                  { provider: "fallback", model: "fixture-stt", capabilities: ["audio"] },
                ],
              },
            },
          },
          ctx,
          media,
          attachments: cache,
          providerRegistry: new Map([
            ["fixture", provider],
            ["fallback", { id: "fallback", transcribeAudio: fallback }],
          ]),
          request: { timeoutMs: 1234 },
          signal: controller.signal,
        }).finally(completed);
        const reason = new Error("The native caller cancelled");
        const rejected = expect(operation).rejects.toBe(reason);
        try {
          await entered.promise;
          controller.abort(reason);
          expect(completed).not.toHaveBeenCalled();
          released.resolve();
          await rejected;
          expect(execute).toHaveBeenCalledOnce();
          expect(fallback).not.toHaveBeenCalled();
        } finally {
          released.resolve();
          await operation.catch(() => undefined);
        }
      });
    },
  );
});
