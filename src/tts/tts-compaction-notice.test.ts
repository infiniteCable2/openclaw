import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  isReplyPayloadTerminalContent,
} from "../auto-reply/reply-payload.js";
import {
  createCompactionHookNoticePayload,
  createCompactionNoticePayload,
} from "../auto-reply/reply/compaction-notice.js";
import { maybeApplyTtsToReplyPayload } from "../auto-reply/reply/dispatch-from-config.payloads.js";
import {
  clearRuntimeConfigSnapshot,
  createMockSpeechProvider,
  createTtsConfig,
  installSpeechProviders,
  maybeApplyTtsToPayloadCore,
  prepareSynthesisMock,
  requireFirstSynthesisRequest,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  type ReplyPayload,
} from "./tts-runtime.test-support.js";

// mock-isolation: Keep only public audio persistence in memory; exercise the real dispatch gate,
// automatic speech policy and native synthesis owner against the configured provider fixture.
vi.mock("./tts.runtime.js", () => ({
  maybeApplyTtsToPayload: async (params: Parameters<typeof maybeApplyTtsToPayloadCore>[0]) => {
    const { maybeApplyTtsToPayloadCore: apply } = await import("./tts-payload.js");
    return apply(params, async () => "/virtual/compaction-notice.ogg");
  },
}));

beforeEach(() => {
  synthesizeMock.mockClear();
  prepareSynthesisMock.mockClear();
  installSpeechProviders([createMockSpeechProvider()]);
});

afterEach(() => {
  setTtsMachinePrefsPathResolver();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

function input(payload: ReplyPayload, ttsAuto = "inbound", inboundAudio = true) {
  const cfg = createTtsConfig("openclaw-native-compaction-notice");
  cfg.tts = { ...cfg.tts, mode: "final" };
  return {
    payload,
    cfg,
    preparedTtsPreferences: {},
    channel: "matrix",
    kind: "block" as const,
    ttsAuto,
    inboundAudio,
  };
}

it.each(["inbound", "always"])(
  "speaks a localized native phase only for the selected %s voice reply and keeps its status identity",
  async (mode) => {
    const payload = createCompactionNoticePayload({ phase: "start", language: "de-DE" });
    const result = await maybeApplyTtsToReplyPayload(input(payload, mode, mode === "inbound"));
    expect(result).toMatchObject({
      text: payload.text,
      spokenText: payload.text,
      mediaUrl: "/virtual/compaction-notice.ogg",
      audioAsVoice: true,
      isCompactionNotice: true,
    });
    expect(requireFirstSynthesisRequest("native voice status").text).toContain(
      "Ich fasse den Kontext zusammen",
    );
    expect(isReplyPayloadStatusNotice(result)).toBe(true);
    expect(isReplyPayloadTerminalContent(result)).toBe(false);
    expect(getReplyPayloadMetadata(result)?.nativeCompactionNotice).toBe(true);
  },
);

it.each([
  { mode: "off", inbound: true },
  { mode: "inbound", inbound: false },
  { mode: "tagged", inbound: true },
])("keeps a $mode/$inbound text-selected native status as text", async ({ mode, inbound }) => {
  const payload = createCompactionNoticePayload({ phase: "queued", language: "de-DE" });
  await expect(maybeApplyTtsToReplyPayload(input(payload, mode, inbound))).resolves.toBe(payload);
  expect(synthesizeMock).not.toHaveBeenCalled();
});

it("never automatically speaks free hook text, a custom override or an unbranded compaction flag", async () => {
  const hook = createCompactionHookNoticePayload({ messages: ["Arbitrary hook progress."] });
  if (!hook) {
    throw new Error("Missing hook fixture");
  }
  const override = createCompactionNoticePayload({ phase: "start", text: "Custom status copy." });
  const unbranded = { text: "Unbranded status copy.", isCompactionNotice: true };
  for (const payload of [hook, override, unbranded]) {
    await expect(maybeApplyTtsToReplyPayload(input(payload, "always"))).resolves.toBe(payload);
    await expect(
      maybeApplyTtsToPayloadCore(input(payload, "always"), async () => "/unused.ogg"),
    ).resolves.toBe(payload);
  }
  expect(synthesizeMock).not.toHaveBeenCalled();
});

it("retains the localized text fallback when status synthesis fails", async () => {
  const payload = createCompactionNoticePayload({ phase: "end", language: "de-DE" });
  synthesizeMock.mockRejectedValueOnce(new Error("synthetic provider unavailable"));
  const result = await maybeApplyTtsToReplyPayload(input(payload));
  expect(result.text).toBe(payload.text);
  expect(result.mediaUrl).toBeUndefined();
  expect(isReplyPayloadStatusNotice(result)).toBe(true);
  expect(isReplyPayloadTerminalContent(result)).toBe(false);
});
