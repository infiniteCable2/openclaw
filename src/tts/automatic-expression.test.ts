import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareAutomaticSpeechExpressionContext } from "./automatic-expression.js";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(() => ({
    autoMode: "inbound",
    prefsPath: "fixture-prefs",
    config: { timeoutMs: 2000 },
  })),
  voice: vi.fn(() => ({ synthesisTarget: "voice-note" })),
  assertPrepared: vi.fn(),
  release: vi.fn(async () => {}),
  prepare: vi.fn(),
}));
vi.mock("./tts-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tts-settings.js")>()),
  resolveTtsSettingsSnapshot: mocks.settings,
}));
vi.mock("../channels/plugins/tts-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/tts-capabilities.js")>()),
  resolveChannelTtsVoiceDelivery: mocks.voice,
}));
vi.mock("./expression-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./expression-preparation.js")>()),
  prepareSpeechExpressionContext: mocks.prepare,
}));

describe("automatic native voice expression admission", () => {
  const cfg: OpenClawConfig = {
    talk: {
      speech: {
        agentProfiles: {
          example: {
            expression: { channels: { matrix: { targets: ["voice-note"] } } },
          },
        },
      },
    },
  };
  const input = () => ({
    cfg,
    tts: { prepareTextToSpeech: vi.fn(async () => ({ success: true })) },
    preparedTtsPreferences: { machinePrefsPath: "fixture-prefs" },
    sessionAuto: "inbound",
    currentInboundAudio: true,
    agentId: "example",
    channelId: "matrix",
    accountId: "primary",
    to: "room:example",
    threadId: "thread-example",
    runId: "run-example",
    sessionId: "session-example",
    assertCurrent: vi.fn(),
    commentaryEnabled: false,
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockReturnValue({
      autoMode: "inbound",
      prefsPath: "fixture-prefs",
      config: { timeoutMs: 2000 },
    });
    mocks.voice.mockReturnValue({ synthesisTarget: "voice-note" });
    mocks.prepare.mockResolvedValue({
      guidance: "Native structured sends.",
      assertCurrent: mocks.assertPrepared,
      expectedSpeechSelection: {
        provider: "example",
        model: "fixture-model",
        voice: "fixture-voice",
      },
      release: mocks.release,
    });
  });
  it("leaves absent exact opt-in cold", async () => {
    for (const changes of [{ channelId: "another" }, { agentId: "another" }, { cfg: {} }]) {
      expect(
        await prepareAutomaticSpeechExpressionContext({ ...input(), ...changes }),
      ).toBeUndefined();
    }
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("does not acquire speech readiness for initial text in inbound mode", async () => {
    expect(
      await prepareAutomaticSpeechExpressionContext({ ...input(), currentInboundAudio: false }),
    ).toBeUndefined();
    expect(mocks.settings).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("prepares initially text input when always mode already requires speech output", async () => {
    mocks.settings.mockReturnValue({
      autoMode: "always",
      prefsPath: "fixture-prefs",
      config: { timeoutMs: 2000 },
    });
    const result = await prepareAutomaticSpeechExpressionContext({
      ...input(),
      currentInboundAudio: false,
    });
    expect(result?.messageSpeechAdmission).toBeDefined();
    expect(mocks.prepare).toHaveBeenCalledOnce();
    await result?.release();
  });
  it("keeps effective off/tagged modes and non-voice-note transports cold", async () => {
    for (const autoMode of ["off", "tagged"]) {
      mocks.settings.mockReturnValue({
        autoMode,
        prefsPath: "fixture-prefs",
        config: { timeoutMs: 2000 },
      });
      expect(await prepareAutomaticSpeechExpressionContext(input())).toBeUndefined();
    }
    mocks.settings.mockReturnValue({
      autoMode: "always",
      prefsPath: "fixture-prefs",
      config: { timeoutMs: 2000 },
    });
    mocks.voice.mockReturnValue({ synthesisTarget: "audio-file" });
    expect(await prepareAutomaticSpeechExpressionContext(input())).toBeUndefined();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("uses prepared preferences and session mode for the same native source readiness", async () => {
    const params = input();
    const result = await prepareAutomaticSpeechExpressionContext(params);
    expect(result?.messageSpeechAdmission.guidance).toBe(result?.guidance);
    expect(mocks.settings).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedTtsPreferences: params.preparedTtsPreferences,
        sessionAuto: "inbound",
      }),
    );
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        prefsPath: "fixture-prefs",
        target: "voice-note",
        agentId: "example",
        channelId: "matrix",
        accountId: "primary",
      }),
    );
    expect(result?.messageSpeechAdmission.route).toEqual({
      channel: "matrix",
      to: "room:example",
      accountId: "primary",
      threadId: "thread-example",
    });
    expect(result?.messageSpeechAdmission.expectedSpeechSelection).toEqual({
      provider: "example",
      model: "fixture-model",
      voice: "fixture-voice",
    });
    result?.messageSpeechAdmission.assertCurrent();
    await result?.release();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("releases readiness when its selected model/provider cannot be bound", async () => {
    mocks.prepare.mockResolvedValueOnce({
      guidance: "Invalid readiness",
      assertCurrent: mocks.assertPrepared,
      release: mocks.release,
    });
    await expect(prepareAutomaticSpeechExpressionContext(input())).rejects.toThrow(
      "identify its selected",
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
