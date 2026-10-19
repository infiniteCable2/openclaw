// Proves opted-in CLI-backend dispatch executes inside embedded lane
// admission: the dispatch decision and the CLI run must happen within the
// enqueued global-lane task, not before it, so dispatched runs obey the same
// lifecycle, placement, and concurrency gates as native embedded runs.
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { CommandQueueEnqueueFn } from "../../process/command-queue.types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import * as runtimeRefresh from "./plugin-runtime-refresh.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const runEmbeddedAgentViaCliBackendIfEligible = vi.hoisted(() => vi.fn());
vi.mock("./cli-backend-dispatch.js", () => ({
  runEmbeddedAgentViaCliBackendIfEligible,
}));

import { runEmbeddedAgent } from "./run.js";

const tempRoot = useSessionStoreTempDirs(afterAll, "cli-dispatch-lane-").make();

const dispatchResult: EmbeddedAgentRunResult = {
  payloads: [{ text: "dispatched" }],
  meta: {
    durationMs: 1,
    agentMeta: { usage: {} },
  },
} as unknown as EmbeddedAgentRunResult;

function laneRunParams(suffix = "") {
  const runId = `run-cli-dispatch-lane-test${suffix}`;
  const sessionId = `recall-lane-session${suffix}`;
  const sessionKey = `agent:main:recall-lane-test${suffix}`;
  return {
    admittedRunContext: createTestAdmittedRunContext(runId),
    sessionId,
    sessionKey,
    agentId: "main",
    sessionTarget: {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: join(tempRoot, "sessions.json"),
    },
    sessionFile: join(tempRoot, "session.jsonl"),
    workspaceDir: join(tempRoot, "workspace"),
    prompt: "recall prompt",
    provider: "claude-cli",
    model: "claude-opus-4-8",
    timeoutMs: 5_000,
    runId,
    config: {},
    cliBackendDispatch: "subscription-auth" as const,
  };
}

describe("runEmbeddedAgent CLI dispatch lane admission", () => {
  beforeEach(() => {
    runEmbeddedAgentViaCliBackendIfEligible.mockReset();
  });

  it("resolves and executes CLI dispatch inside the global-lane task", async () => {
    const order: string[] = [];
    runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
      order.push("dispatch-run");
      return dispatchResult;
    });
    // The custom enqueue hook stands in for both the session and the global
    // lane, so a compliant run enters it twice before dispatching.
    const enqueue: CommandQueueEnqueueFn = async (task) => {
      order.push("global-lane-enter");
      const result = await task();
      order.push("global-lane-exit");
      return result;
    };

    const params = laneRunParams();
    const sessionEntry: InternalSessionEntry = {
      sessionId: params.sessionId,
      updatedAt: 1,
      lifecycleRevision: "cli-dispatch-lifecycle",
    };
    await upsertSessionEntryCore(params.sessionTarget, sessionEntry);
    const prepareConversationContext = vi.fn(async (run: RunEmbeddedAgentParams) => {
      expect(run.sessionTarget).toMatchObject({
        ...params.sessionTarget,
        expectedWriterRunId: params.runId,
        expectedLifecycleRevision: sessionEntry.lifecycleRevision,
      });
      order.push("knowledge-prepare");
      return [{ kind: "conversation-data" as const, text: "Authorized related observations." }];
    });
    const result = await runEmbeddedAgent({ ...params, enqueue, prepareConversationContext });

    expect(result.payloads?.[0]?.text).toBe("dispatched");
    // Both lane admissions (session, then global) must fully wrap the
    // dispatch decision and execution.
    expect(order).toEqual([
      "global-lane-enter",
      "global-lane-enter",
      "knowledge-prepare",
      "dispatch-run",
      "global-lane-exit",
      "global-lane-exit",
    ]);
    expect(runEmbeddedAgentViaCliBackendIfEligible).toHaveBeenCalledTimes(1);
    expect(prepareConversationContext).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentViaCliBackendIfEligible.mock.calls[0]?.[0]).toMatchObject({
      prepareConversationContext: undefined,
      runtimeContextFragments: [
        { kind: "conversation-data", text: "Authorized related observations." },
      ],
    });
    expect(runEmbeddedAgentViaCliBackendIfEligible.mock.calls[0]?.[0].sessionTarget).toMatchObject({
      ...params.sessionTarget,
      expectedWriterRunId: params.runId,
      expectedLifecycleRevision: sessionEntry.lifecycleRevision,
    });
  });

  it("does not admit conversation context before both native queue boundaries", async () => {
    const params = laneRunParams("-knowledge-queues");
    await upsertSessionEntryCore(params.sessionTarget, {
      sessionId: params.sessionId,
      updatedAt: 1,
      lifecycleRevision: "knowledge-queue-lifecycle",
    });
    const sessionEntered = createDeferred();
    const globalEntered = createDeferred();
    const releaseSession = createDeferred();
    const releaseGlobal = createDeferred();
    let queueIndex = 0;
    const enqueue: CommandQueueEnqueueFn = async (task) => {
      const index = queueIndex++;
      if (index === 0) {
        sessionEntered.resolve();
        await releaseSession.promise;
      } else {
        globalEntered.resolve();
        await releaseGlobal.promise;
      }
      return task();
    };
    const prepareConversationContext = vi.fn(async () => []);
    runEmbeddedAgentViaCliBackendIfEligible.mockResolvedValue(dispatchResult);
    const pending = runEmbeddedAgent({ ...params, enqueue, prepareConversationContext });
    try {
      await awaitGateBeforeSettlement(
        sessionEntered.promise,
        pending,
        "session lane was not queued",
      );
      expect(prepareConversationContext).not.toHaveBeenCalled();
      releaseSession.resolve();
      await awaitGateBeforeSettlement(globalEntered.promise, pending, "global lane was not queued");
      expect(prepareConversationContext).not.toHaveBeenCalled();
      expect(runEmbeddedAgentViaCliBackendIfEligible).not.toHaveBeenCalled();
      releaseGlobal.resolve();
      await pending;
      expect(prepareConversationContext).toHaveBeenCalledTimes(1);
      expect(queueIndex).toBe(2);
    } finally {
      releaseSession.resolve();
      releaseGlobal.resolve();
      await pending.catch(() => {});
    }
  });

  it.each(["failed", "cancelled"] as const)(
    "releases native refresh ownership when context preparation is %s before hydration",
    async (outcome) => {
      const params = laneRunParams(`-knowledge-${outcome}`);
      await upsertSessionEntryCore(params.sessionTarget, {
        sessionId: params.sessionId,
        updatedAt: 1,
        lifecycleRevision: `knowledge-${outcome}-lifecycle`,
      });
      const close = vi.fn();
      const originalFactory = runtimeRefresh.createEmbeddedAgentPluginRuntimeRefresh;
      const refreshFactory = vi
        .spyOn(runtimeRefresh, "createEmbeddedAgentPluginRuntimeRefresh")
        .mockImplementation((input) => {
          const refresh = originalFactory(input);
          const originalClose = refresh.close;
          refresh.close = () => {
            close();
            originalClose();
          };
          return refresh;
        });
      const controller = new AbortController();
      let lanesActive = 0;
      const enqueue: CommandQueueEnqueueFn = async (task) => {
        lanesActive++;
        try {
          return await task();
        } finally {
          lanesActive--;
        }
      };
      try {
        await expect(
          runEmbeddedAgent({
            ...params,
            enqueue,
            abortSignal: controller.signal,
            prepareConversationContext: async () => {
              expect(lanesActive).toBe(2);
              if (outcome === "failed") {
                throw new Error("Knowledge source unavailable");
              }
              controller.abort(new Error("Knowledge preparation cancelled"));
              return [];
            },
          }),
        ).rejects.toThrow(
          outcome === "failed" ? "Knowledge source unavailable" : /cancelled|abort/i,
        );
        expect(runEmbeddedAgentViaCliBackendIfEligible).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
        expect(lanesActive).toBe(0);
      } finally {
        refreshFactory.mockRestore();
      }
    },
  );
});
