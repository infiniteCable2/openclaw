import { describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  runCliAgentMock,
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";
import { enqueueFollowupRun } from "./queue.js";

// Use the existing runner harness: its queue sink decides actual admission in
// these orchestration cases; native queue custody has its own focused tests.
await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});
setupAgentRunnerTestHooks();

describe("new input while the native reply owner is compacting", () => {
  it("acknowledges each accepted request on its original route without another model run", async () => {
    const operation = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    operation.setPhase("preflight_compacting");
    const onCompactionNotice = vi.fn();
    try {
      for (const messageId of ["request-one", "request-two"]) {
        vi.mocked(enqueueFollowupRun).mockReturnValueOnce(true);
        const input = createBaseRun({
          context: { Provider: "whatsapp", MessageSid: messageId },
          run: { config: { agents: { defaults: { compaction: { notifyUser: true } } } } },
          reply: {
            sessionKey: "main",
            isActive: true,
            shouldFollowup: true,
            opts: { onCompactionNotice },
          },
        });
        // Interrupt mode bypasses queuing; this case admits input behind the compacting owner.
        input.resolvedQueue.mode = "collect";
        await expect(input.run()).resolves.toBeUndefined();
      }
      expect(enqueueFollowupRun).toHaveBeenCalledTimes(2);
      expect(onCompactionNotice).toHaveBeenCalledTimes(2);
      expect(onCompactionNotice).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          replyToId: "request-one",
          isCompactionNotice: true,
        }),
      );
      expect(onCompactionNotice).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          replyToId: "request-two",
          isCompactionNotice: true,
        }),
      );
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(runCliAgentMock).not.toHaveBeenCalled();
    } finally {
      operation.complete();
    }
  });

  it.each(["not-compacting", "not-admitted", "automatic"] as const)(
    "does not claim a waiting compaction for %s input",
    async (caseName) => {
      const operation = createReplyOperation({
        sessionKey: "main",
        sessionId: "session",
        resetTriggered: false,
      });
      if (caseName !== "not-compacting") {
        operation.setPhase("preflight_compacting");
      }
      const onCompactionNotice = vi.fn();
      vi.mocked(enqueueFollowupRun).mockReturnValueOnce(caseName !== "not-admitted");
      const input = createBaseRun({
        run: {
          config: { agents: { defaults: { compaction: { notifyUser: true } } } },
          ...(caseName === "automatic" ? { inputProvenance: { kind: "internal_system" } } : {}),
        },
        reply: {
          sessionKey: "main",
          isActive: true,
          shouldFollowup: true,
          opts: { onCompactionNotice },
        },
      });
      input.resolvedQueue.mode = "collect";
      try {
        await expect(input.run()).resolves.toBeUndefined();
        expect(onCompactionNotice).not.toHaveBeenCalled();
        expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
        expect(runCliAgentMock).not.toHaveBeenCalled();
      } finally {
        operation.complete();
      }
    },
  );
});
