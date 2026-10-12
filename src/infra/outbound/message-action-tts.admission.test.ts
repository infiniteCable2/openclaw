import { describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { MessageSpeechAdmission } from "../../tts/message-speech-admission.js";
import {
  maybeApplyTtsToMessageActionSendPayload,
  resolveMessageSpeechAdmission,
} from "./message-action-tts.js";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(async ({ payload }: { payload: ReplyPayload }) => payload),
  prefs: vi.fn(async () => ({})),
}));
vi.mock("../../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions.js")>()),
  resolveSessionStorePathCore: () => "fixture-store",
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  loadSessionEntryReadOnly: () => ({ ttsAuto: "inbound" }),
}));
vi.mock("../../tts/tts-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tts/tts-preferences.js")>()),
  prepareTtsPreferences: mocks.prefs,
}));
// mock-isolation: importing the real TTS runtime installs process-global availability/preferences resolvers and binds persistent synthesis; this fixture isolates that runtime handoff.
vi.mock("../../tts/tts.runtime.js", () => ({ maybeApplyTtsToPayload: mocks.apply }));

function admission(): MessageSpeechAdmission {
  return {
    runId: "run-example",
    sessionId: "session-example",
    agentId: "example",
    route: {
      channel: "example-channel",
      accountId: "primary",
      to: "room:example",
      threadId: "thread-example",
    },
    assertCurrent: vi.fn(),
    prefsPath: "fixture-prefs",
    preparedTtsPreferences: {},
    localServiceAdmission: {
      generation: "generation-example",
      signal: new AbortController().signal,
    },
    expectedSpeechSelection: { provider: "example", model: "fixture-model" },
  };
}
function route(bound: MessageSpeechAdmission) {
  return {
    admission: bound,
    runId: bound.runId,
    sessionId: bound.sessionId,
    agentId: bound.agentId,
    channel: bound.route.channel,
    accountId: bound.route.accountId,
    target: bound.route.to,
    threadId: bound.route.threadId,
  };
}
describe("native message speech admission routing", () => {
  it("accepts only the exact live source route and native run", () => {
    const bound = admission();
    expect(resolveMessageSpeechAdmission(route(bound))).toBe(bound);
    for (const changes of [
      { agentId: "other" },
      { channel: "other" },
      { accountId: "other" },
      { target: "room:other" },
      { threadId: "other" },
    ]) {
      expect(resolveMessageSpeechAdmission({ ...route(bound), ...changes })).toBeUndefined();
    }
    expect(() => resolveMessageSpeechAdmission({ ...route(bound), runId: "other-run" })).toThrow(
      "does not belong",
    );
    bound.assertCurrent = () => {
      throw new Error("retired native owner");
    };
    expect(() => resolveMessageSpeechAdmission(route(bound))).toThrow("retired native owner");
  });
  it("carries the same worker admission to native synthesis without serializing it into reply facts", async () => {
    const bound = admission();
    const payload = setReplyPayloadMetadata(
      { text: "Hello." },
      {
        ttsExplicit: true,
        tts: { tagged: true, text: "Hello.", expression: { parts: [{ text: "Hello." }] } },
      },
    );
    const caller = new AbortController();
    const assertCommitAllowed = vi.fn();
    await maybeApplyTtsToMessageActionSendPayload({
      ...route(bound),
      messageSpeechAdmission: bound,
      payload,
      cfg: {},
      dryRun: false,
      sessionKey: "agent:example:chat:test",
      inboundAudio: true,
      signal: caller.signal,
      assertCommitAllowed,
    });
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        messageSpeechAdmission: bound,
        preparedTtsPreferences: bound.preparedTtsPreferences,
        signal: caller.signal,
        assertCommitAllowed,
      }),
    );
    expect(JSON.stringify(payload)).not.toContain("generation-example");
  });
  it("rejects a neutral source-text fallback before loading native synthesis", async () => {
    mocks.apply.mockClear();
    const bound = admission();
    await expect(
      maybeApplyTtsToMessageActionSendPayload({
        ...route(bound),
        messageSpeechAdmission: bound,
        payload: { text: "Neutral fallback." },
        cfg: {},
        dryRun: false,
      }),
    ).rejects.toThrow("structured native");
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("keeps requested attachment sends on their original non-TTS path", async () => {
    const bound = admission();
    const payload = { text: "Requested file.", mediaUrl: "https://example.test/fixture.txt" };
    const result = await maybeApplyTtsToMessageActionSendPayload({
      ...route(bound),
      messageSpeechAdmission: bound,
      payload,
      cfg: {},
      dryRun: false,
    });
    expect(result).toBe(payload);
    expect(bound.assertCurrent).not.toHaveBeenCalled();
  });
  it("does not loan source readiness to an explicitly addressed foreign recipient", async () => {
    mocks.apply.mockClear();
    const bound = admission();
    const payload = setReplyPayloadMetadata(
      { text: "Hello." },
      {
        ttsExplicit: true,
        tts: { tagged: true, text: "Hello.", expression: { parts: [{ text: "Hello." }] } },
      },
    );
    await maybeApplyTtsToMessageActionSendPayload({
      ...route(bound),
      target: "room:other",
      messageSpeechAdmission: bound,
      payload,
      cfg: {},
      dryRun: false,
    });
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({ messageSpeechAdmission: undefined }),
    );
    expect(bound.assertCurrent).not.toHaveBeenCalled();
  });
});
