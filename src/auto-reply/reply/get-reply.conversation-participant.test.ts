import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  buildGetReplyCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  initSessionState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  waitForRecording: vi.fn<() => Promise<void>>(),
}));
// mock-isolation: Replace asynchronous recording, not getReply's join/ordering owner.
vi.mock("../../sessions/session-participant-recording.js", () => ({
  waitForSessionParticipantRecording: mocks.waitForRecording,
}));
// mock-isolation: Baseline disk capture is independent of participant ordering.
vi.mock("./session-diff-baseline.js", () => ({
  prepareReplySessionDiffBaseline: vi.fn(async () => undefined),
}));
registerGetReplyRuntimeOverrides(mocks);
const { getReplyFromConfig } = await import("./get-reply.js");
const { runPreparedReply } = await import("./get-reply-run.js");

const cfg: OpenClawConfig = {
  agents: { entries: { main: { conversationMode: "branches" } } },
};

beforeEach(() => {
  vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.mocked(runPreparedReply).mockClear();
  mocks.initSessionState.mockResolvedValue(createGetReplySessionState());
  mocks.waitForRecording.mockResolvedValue();
  mocks.resolveReplyDirectives.mockResolvedValue(
    createGetReplyContinueDirectivesResult({
      body: "hello",
      abortKey: "agent:main:telegram:123",
      from: "telegram:user:42",
      to: "telegram:123",
      senderId: "telegram:user:42",
      commandSource: "text",
      senderIsOwner: false,
      resetHookTriggered: false,
    }),
  );
  mocks.handleInlineActions.mockResolvedValue({
    kind: "continue",
    directives: {},
    cleanedBody: "hello",
  });
});
afterEach(() => vi.unstubAllEnvs());

function originalInput() {
  const ctx = buildGetReplyCtx();
  prepareSessionParticipantInput(ctx, { type: "profile", id: "example-person" });
  return ctx;
}

describe("native branch reply joins its accepted participant before model preparation", () => {
  it("waits for the actual session target's pending credit before running the turn", async () => {
    const started = createDeferredCore();
    const persisted = createDeferredCore();
    mocks.waitForRecording.mockImplementation(() => {
      started.resolve();
      return persisted.promise;
    });
    const reply = getReplyFromConfig(originalInput(), undefined, cfg);
    try {
      await awaitGateBeforeSettlement(started.promise, reply, "Reply skipped its participant join");
      expect(mocks.initSessionState).toHaveBeenCalledOnce();
      expect(mocks.waitForRecording).toHaveBeenCalledWith({
        agentId: "main",
        sessionKey: "agent:main:telegram:123",
        storePath: "/tmp/sessions.json",
      });
      expect(runPreparedReply).not.toHaveBeenCalled();
    } finally {
      persisted.resolve();
    }
    await reply;
    expect(runPreparedReply).toHaveBeenCalledOnce();
  });

  it("does not run after cancellation while native participant recording settles", async () => {
    const controller = new AbortController();
    mocks.waitForRecording.mockImplementation(async () => controller.abort());
    await expect(
      getReplyFromConfig(originalInput(), { abortSignal: controller.signal }, cfg),
    ).rejects.toThrow("canceled during preprocessing");
    expect(runPreparedReply).not.toHaveBeenCalled();
  });

  it.each(["native", "absent"] as const)(
    "leaves %s participant behavior unchanged",
    async (mode) => {
      await getReplyFromConfig(
        mode === "absent" ? buildGetReplyCtx() : originalInput(),
        undefined,
        mode === "native" ? {} : cfg,
      );
      expect(mocks.waitForRecording).not.toHaveBeenCalled();
      expect(runPreparedReply).toHaveBeenCalledOnce();
    },
  );
});
