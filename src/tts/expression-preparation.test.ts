import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareSpeechExpressionContext } from "./expression-preparation.js";
import type { TtsTelephonyPreparationResult } from "./tts-runtime-types.js";

const cfg: OpenClawConfig = {
  talk: {
    speech: {
      agentProfiles: {
        reader: { expression: { channels: { matrix: { targets: ["voice-note"] } } } },
      },
    },
  },
};

function fixture(result: TtsTelephonyPreparationResult) {
  const prepare = vi.fn(async () => result);
  return {
    cfg,
    tts: { prepareTextToSpeech: prepare },
    agentId: "reader",
    channelId: "matrix",
    target: "voice-note" as const,
    currentSourceSpeechTarget: false,
    commentaryEnabled: false,
  };
}

describe("speech expression context preparation", () => {
  it.each([
    { agentId: "other" },
    { channelId: "other" },
    { target: "telephony" as const },
    { cfg: {} },
  ])("keeps disabled or unmatched contexts cold: %j", async (override) => {
    const params = fixture({ success: true });
    expect(await prepareSpeechExpressionContext({ ...params, ...override })).toBeUndefined();
    expect(params.tts.prepareTextToSpeech).not.toHaveBeenCalled();
  });

  it("binds guidance to real readiness and closes it before releasing the resource", async () => {
    const worker = new AbortController();
    const release = vi.fn(async () => undefined);
    const params = fixture({
      success: true,
      expressionCapabilities: {
        emotions: ["tender"],
        vocalEvents: ["sigh"],
        emphasis: false,
        whisper: false,
      },
      localServiceAdmission: { generation: "synthetic-worker", signal: worker.signal },
      release,
    });
    const context = await prepareSpeechExpressionContext(params);
    expect(context?.guidance).toContain('Emotion identifiers: ["tender"]');
    expect(context?.localServiceAdmission?.signal).toBe(worker.signal);
    expect(context?.assertCurrent()).toBeUndefined();
    await context?.release();
    await context?.release();
    expect(release).toHaveBeenCalledTimes(1);
    expect(() => context?.assertCurrent()).toThrow("preparation is closed");
  });

  it("invalidates the model context when the real worker lifetime ends", async () => {
    const worker = new AbortController();
    const params = fixture({
      success: true,
      expressionCapabilities: { emotions: [], vocalEvents: [], emphasis: false, whisper: false },
      localServiceAdmission: { generation: "synthetic-worker", signal: worker.signal },
    });
    const context = await prepareSpeechExpressionContext(params);
    worker.abort(new Error("Worker replaced"));
    expect(() => context?.assertCurrent()).toThrow("Worker replaced");
    await context?.release();
  });

  it("does not substitute declared capabilities when actual admission is missing", async () => {
    const release = vi.fn(async () => undefined);
    await expect(
      prepareSpeechExpressionContext(fixture({ success: true, release })),
    ).rejects.toThrow("did not admit expression capabilities");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("fails explicitly on a host without the configured readiness capability", async () => {
    await expect(
      prepareSpeechExpressionContext({ ...fixture({ success: true }), tts: {} }),
    ).rejects.toThrow("require native speech readiness support");
  });

  it.each([{ enabled: false }, { allowText: false }])(
    "rejects forbidden speech overrides before readiness: %j",
    async (modelOverrides) => {
      const params = fixture({ success: true });
      await expect(
        prepareSpeechExpressionContext({
          ...params,
          cfg: { ...cfg, tts: { modelOverrides } },
        }),
      ).rejects.toThrow("require enabled speech text overrides");
      expect(params.tts.prepareTextToSpeech).not.toHaveBeenCalled();
    },
  );

  it("preserves admission failure and cleanup failure together", async () => {
    const cleanupError = new Error("Release failed");
    const release = vi.fn(async () => {
      throw cleanupError;
    });
    const error = await prepareSpeechExpressionContext(fixture({ success: false, release })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toHaveProperty("cause", cleanupError);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
