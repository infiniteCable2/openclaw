import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import { prepareSpeechSession, type SpeechSessionPreparation } from "./preparation.js";

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
  return { tts: { prepareTextToSpeechTelephony } } as unknown as PluginRuntime;
}
const config = {
  audioFormat: "pcm16-24khz" as const,
  agentId: "reader",
  transcriptionProvider: "prepared-stt",
  providers: { "prepared-stt": {} },
};

describe("prepareSpeechSession", () => {
  it("rejects an explicitly missing provider without preparing a different one", async () => {
    const prepare = vi.fn(async () => ({ release: vi.fn() }));
    const prepareTts = vi.fn(async () => ({ success: true }));
    await expect(
      prepareSpeechSession({
        config: { ...config, transcriptionProvider: "missing" },
        fullConfig: {},
        runtime: createRuntime(prepareTts),
        providers: [createProvider(prepare)],
      }),
    ).rejects.toThrow('Realtime transcription provider "missing" is not registered');
    expect(prepare).not.toHaveBeenCalled();
    expect(prepareTts).not.toHaveBeenCalled();
  });
  it("prepares both speech directions and retains their resources", async () => {
    const releaseStt = vi.fn();
    const releaseTts = vi.fn(async () => undefined);
    const prepareSession = vi.fn(async () => ({ release: releaseStt }));
    const prepareTts = vi.fn(async () => ({ success: true, release: releaseTts }));
    const signal = new AbortController().signal;

    const preparation = await prepareSpeechSession({
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
      prepareSpeechSession({
        config,
        fullConfig: {} as never,
        runtime: createRuntime(vi.fn(async () => ({ success: false, error: "not ready" }))),
        providers: [provider],
      }),
    ).rejects.toThrow("not ready");
    expect(releaseStt).toHaveBeenCalledOnce();
  });

  it("reports release failures and retries only the unreleased resource", async () => {
    const failure = new Error("lease release failed");
    const firstRelease = createDeferred<void>();
    const releaseStt = vi
      .fn(() => firstRelease.promise)
      .mockImplementationOnce(() => firstRelease.promise)
      .mockImplementationOnce(async () => undefined);
    const releaseTts = vi.fn(async () => undefined);
    const preparation = await prepareSpeechSession({
      config,
      fullConfig: {},
      runtime: createRuntime(vi.fn(async () => ({ success: true, release: releaseTts }))),
      providers: [createProvider(vi.fn(async () => ({ release: releaseStt })))],
    });

    const first = preparation.release();
    const overlapping = preparation.release();
    expect(overlapping).toBe(first);
    const rejection = expect(first).rejects.toThrow(
      "Speech preparation resources could not be released",
    );
    firstRelease.reject(failure);
    await rejection;
    expect(releaseStt).toHaveBeenCalledOnce();
    expect(releaseTts).toHaveBeenCalledOnce();
    await preparation.release();
    await preparation.release();
    expect(releaseStt).toHaveBeenCalledTimes(2);
    expect(releaseTts).toHaveBeenCalledOnce();
  });

  it("retains failed-start ownership and retries a transient cleanup failure", async () => {
    const leaseFailure = new Error("lease cleanup failed");
    const readinessFailure = new Error("TTS not ready");
    const releaseStt = vi.fn(async () => undefined).mockRejectedValueOnce(leaseFailure);
    let owned: SpeechSessionPreparation | undefined;
    const result = prepareSpeechSession({
      config,
      fullConfig: {},
      runtime: createRuntime(
        vi.fn(async () => {
          throw readinessFailure;
        }),
      ),
      providers: [createProvider(vi.fn(async () => ({ release: releaseStt })))],
      onPreparation: (preparation) => {
        owned = preparation;
      },
    });
    const error = await result.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      readinessFailure,
      expect.objectContaining({ errors: [leaseFailure] }),
    ]);
    expect(releaseStt).toHaveBeenCalledOnce();
    await expectDefined(owned, "Failed readiness must retain its cleanup owner").release();
    await owned?.release();
    expect(releaseStt).toHaveBeenCalledTimes(2);
  });

  it.each(["stt", "tts"] as const)(
    "releases the parallel readiness hold when %s throws synchronously",
    async (failingProvider) => {
      const failure = new Error("synchronous readiness failure");
      const release = vi.fn(async () => undefined);
      const provider = createProvider(() => {
        if (failingProvider === "stt") {
          throw failure;
        }
        return Promise.resolve({ release });
      });
      const prepareTts = vi.fn(() => {
        if (failingProvider === "tts") {
          throw failure;
        }
        return Promise.resolve({ success: true, release });
      });
      await expect(
        prepareSpeechSession({
          config,
          fullConfig: {},
          runtime: createRuntime(prepareTts),
          providers: [provider],
        }),
      ).rejects.toBe(failure);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("cleans up both acquired holds when the ownership handoff throws", async () => {
    const failure = new Error("handoff failed");
    const releaseStt = vi.fn(async () => undefined);
    const releaseTts = vi.fn(async () => undefined);
    await expect(
      prepareSpeechSession({
        config,
        fullConfig: {},
        runtime: createRuntime(vi.fn(async () => ({ success: true, release: releaseTts }))),
        providers: [createProvider(vi.fn(async () => ({ release: releaseStt })))],
        onPreparation: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(releaseStt).toHaveBeenCalledOnce();
    expect(releaseTts).toHaveBeenCalledOnce();
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
      prepareSpeechSession({
        config,
        fullConfig: {} as never,
        runtime,
        providers: [provider],
      }),
      prepareSpeechSession({
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
