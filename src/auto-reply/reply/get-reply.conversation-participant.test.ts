import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { validateConfigObject } from "../../config/validation-core.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
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

function resolvedConfig(mode: "branches" | "native" = "branches"): OpenClawConfig {
  const validated = validateConfigObject(
    { agents: { entries: { main: { conversationMode: mode } } } },
    { manifestRegistry: { plugins: [], diagnostics: [] } },
  );
  if (!validated.ok)
    throw new Error("Invalid participant reply fixture", { cause: validated.issues });
  return markCompleteReplyConfig(validated.config, { runtimeMode: "full" });
}

const cfg = resolvedConfig();

beforeEach(() => {
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
function originalInput() {
  const ctx = buildGetReplyCtx();
  prepareSessionParticipantInput(ctx, { type: "profile", id: "example-person" });
  return ctx;
}

describe("native reply joins its accepted participant before model preparation", () => {
  it.each(["branches", "native"] as const)(
    "joins %s input's pending audience publication before the post-initialization source check",
    async (mode) => {
      const started = createDeferredCore();
      const persisted = createDeferredCore();
      let pending = false;
      mocks.initSessionState.mockImplementation(async () => {
        pending = true;
        return createGetReplySessionState();
      });
      mocks.waitForRecording.mockImplementation(async () => {
        started.resolve();
        await persisted.promise;
        pending = false;
      });
      const assertSourceCurrent = vi.fn(() => {
        if (pending) throw new Error("Native participant publication is still pending");
      });
      const reply = getReplyFromConfig(
        originalInput(),
        { assertSourceCurrent },
        resolvedConfig(mode),
      );
      try {
        // On the old seam traceGetReplyPhase rechecks this source while pending,
        // rejects the actual getReply invocation, and never reaches this join.
        await awaitGateBeforeSettlement(
          started.promise,
          reply,
          "Source checked before native join",
        );
        expect(runPreparedReply).not.toHaveBeenCalled();
      } finally {
        persisted.resolve();
      }
      await reply;
      expect(pending).toBe(false);
      expect(assertSourceCurrent).toHaveBeenCalled();
      expect(runPreparedReply).toHaveBeenCalledOnce();
    },
  );

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

  it("rechecks a revoked original source after native recording settles", async () => {
    let revoked = false;
    mocks.waitForRecording.mockImplementation(async () => {
      revoked = true;
    });
    await expect(
      getReplyFromConfig(
        originalInput(),
        {
          assertSourceCurrent() {
            if (revoked) throw new Error("Original source revoked during recording");
          },
        },
        cfg,
      ),
    ).rejects.toThrow("Original source revoked during recording");
    expect(runPreparedReply).not.toHaveBeenCalled();
  });

  it.each(["branches", "native"] as const)(
    "does not manufacture participant credit in %s mode when original evidence is absent",
    async (mode) => {
      await getReplyFromConfig(buildGetReplyCtx(), undefined, resolvedConfig(mode));
      expect(mocks.waitForRecording).not.toHaveBeenCalled();
      expect(runPreparedReply).toHaveBeenCalledOnce();
    },
  );
});
