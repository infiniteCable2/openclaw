import { beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { MessageSpeechAdmission } from "../../tts/message-speech-admission.js";
import { maybeApplyTtsToMessageActionSendPayload } from "./message-action-tts.js";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(async ({ payload }: { payload: ReplyPayload }) => payload),
  prefs: vi.fn(async () => ({})),
}));
// mock-isolation: Session-store resolution must not initialize persistent state in this handoff fixture.
vi.mock("../../config/sessions.js", () => ({
  resolveSessionStorePathCore: () => "fixture-store",
}));
// mock-isolation: Foreign routes read fixture session preferences, never an operator database.
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: () => ({ ttsAuto: "inbound" }),
}));
// mock-isolation: The preference owner stays outside the admitted-worker handoff being tested.
vi.mock("../../tts/tts-preferences.js", () => ({
  prepareTtsPreferences: mocks.prefs,
}));
// mock-isolation: importing the real TTS runtime installs process-global availability/preferences resolvers and binds persistent synthesis; this fixture isolates that runtime handoff.
vi.mock("../../tts/tts.runtime.js", () => ({ maybeApplyTtsToPayload: mocks.apply }));

function admission(assertCurrent = vi.fn()): MessageSpeechAdmission {
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
    assertCurrent,
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
    messageSpeechAdmission: bound,
    runId: bound.runId,
    sessionId: bound.sessionId,
    agentId: bound.agentId,
    channel: bound.route.channel,
    accountId: bound.route.accountId,
    target: bound.route.to,
    threadId: bound.route.threadId,
  };
}
function speechPayload() {
  return setReplyPayloadMetadata(
    { text: "Hello." },
    {
      ttsExplicit: true,
      tts: { tagged: true, text: "Hello.", expression: { parts: [{ text: "Hello." }] } },
    },
  );
}

describe("native message speech admission routing", () => {
  beforeEach(() => {
    mocks.apply.mockClear();
    mocks.prefs.mockClear();
  });

  it("carries the same worker admission to native synthesis without serializing it into reply facts", async () => {
    const bound = admission();
    const payload = speechPayload();
    const caller = new AbortController();
    const assertCommitAllowed = vi.fn();
    await maybeApplyTtsToMessageActionSendPayload({
      ...route(bound),
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

  it.each(["runId", "sessionId"] as const)(
    "rejects a source admission from another %s before preparing synthesis",
    async (identity) => {
      const bound = admission();
      await expect(
        maybeApplyTtsToMessageActionSendPayload({
          ...route(bound),
          [identity]: "other",
          payload: speechPayload(),
          cfg: {},
          dryRun: false,
        }),
      ).rejects.toThrow("does not belong");
      expect(mocks.prefs).not.toHaveBeenCalled();
      expect(mocks.apply).not.toHaveBeenCalled();
    },
  );

  it("rejects a retired native owner before preparing synthesis", async () => {
    const bound = admission();
    bound.assertCurrent = () => {
      throw new Error("retired native owner");
    };
    await expect(
      maybeApplyTtsToMessageActionSendPayload({
        ...route(bound),
        payload: speechPayload(),
        cfg: {},
        dryRun: false,
      }),
    ).rejects.toThrow("retired native owner");
    expect(mocks.prefs).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("passes plain source text and its retained admission to native synthesis", async () => {
    const bound = admission();
    const payload = { text: "An ordinary spoken answer." };
    await maybeApplyTtsToMessageActionSendPayload({
      ...route(bound),
      payload,
      cfg: { tts: { auto: "inbound" } },
      inboundAudio: true,
      dryRun: false,
    });
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({ payload, messageSpeechAdmission: bound, inboundAudio: true }),
    );
  });
  it("keeps requested attachment sends on their original non-TTS path", async () => {
    const assertCurrent = vi.fn();
    const bound = admission(assertCurrent);
    const payload = { text: "Requested file.", mediaUrl: "https://example.test/fixture.txt" };
    const result = await maybeApplyTtsToMessageActionSendPayload({
      ...route(bound),
      payload,
      cfg: {},
      dryRun: false,
    });
    expect(result).toBe(payload);
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  const foreignRoutes = [
    { name: "agent", changes: { agentId: "other" } },
    { name: "channel", changes: { channel: "other" } },
    { name: "account", changes: { accountId: "other" } },
    { name: "recipient", changes: { target: "room:other" } },
    { name: "thread", changes: { threadId: "other" } },
  ] as const;
  it.each(foreignRoutes)("does not loan source readiness to another $name", async ({ changes }) => {
    const assertCurrent = vi.fn();
    const bound = admission(assertCurrent);
    await maybeApplyTtsToMessageActionSendPayload({
      ...route(bound),
      ...changes,
      payload: speechPayload(),
      cfg: {},
      dryRun: false,
    });
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({ messageSpeechAdmission: undefined }),
    );
    expect(assertCurrent).not.toHaveBeenCalled();
  });
});
