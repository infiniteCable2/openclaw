import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import type { admitFollowupTurn } from "./followup-turn-admission.js";
import {
  createFollowupTurnTestTypingController,
  createFollowupTurnTestTurn,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import {
  clearFollowupQueueForTest,
  createQueueSettings,
  createQueueTestRun,
} from "./queue.test-helpers.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { FollowupRunDeferredError, type FollowupRun } from "./queue/types.js";
import type { SessionEventExecution } from "./session-event-contract.js";

const notices = vi.hoisted(() => ({ admission: false }));

// mock-isolation: Keep database admission outside this queue-to-execution ownership proof.
vi.mock("./followup-turn-admission.js", () => ({
  admitFollowupTurn: async ({
    queued,
    onCompactionNoticePayload,
  }: Parameters<typeof admitFollowupTurn>[0]) => {
    const turn = createFollowupTurnTestTurn({ runId: `execution-${queued.prompt}`, queued });
    if (notices.admission) {
      await onCompactionNoticePayload?.({ text: "native-start", isCompactionNotice: true }, turn);
    }
    return { kind: "admitted", turn };
  },
}));

// mock-isolation: No result accounting or worker initialization is needed for an aborted stub turn.
vi.mock("./agent-runner-result-accounting.js", () => ({
  accountFollowupTurn: async () => undefined,
}));

// mock-isolation: Exercise execution callbacks without loading outbound transport/plugin runtimes.
vi.mock("./followup-delivery.js", () => ({
  resolveFollowupDeliveryDecision: async ({
    opts,
  }: Parameters<typeof resolveFollowupDeliveryDecision>[0]) => {
    await opts?.resolveReplyDelivery?.(2);
    return { kind: "suppress", reason: "aborted" };
  },
  deliverFollowupDecision: async () => ({ kind: "completed", payloads: [] }),
}));

type FollowupRunObservers = NonNullable<FollowupRun["runObservers"]>;

const { createFollowupRunner } = await import("./followup-runner.js");
const state = getFollowupTurnTestState();
const key = "followup-turn-callback-ownership";

function createObservers() {
  return {
    onDeliberateSilentTerminalReply: vi.fn(),
    onAgentRunStart: vi.fn<NonNullable<FollowupRunObservers["onAgentRunStart"]>>(),
    onAgentRunTerminalOutcome:
      vi.fn<NonNullable<FollowupRunObservers["onAgentRunTerminalOutcome"]>>(),
    onModelSelected: vi.fn<NonNullable<FollowupRunObservers["onModelSelected"]>>(),
    prepareAssistantTranscriptMessage: vi.fn<
      NonNullable<FollowupRunObservers["prepareAssistantTranscriptMessage"]>
    >((message) => message),
    resolveReplyDelivery: vi.fn<NonNullable<FollowupRunObservers["resolveReplyDelivery"]>>(
      async () => "delivered",
    ),
  };
}

beforeEach(() => {
  notices.admission = false;
  vi.useFakeTimers();
  resetFollowupTurnTestState();
});

afterEach(() => {
  clearFollowupQueueForTest(key);
  vi.useRealTimers();
});

describe("queued turn callback ownership", () => {
  it.for(["open", "closed", "without-hook"] as const)(
    "routes %s original Talk status before final delivery without borrowing queue defaults",
    async (sinkState, { signal }) => {
      notices.admission = true;
      const started = createDeferred();
      const release = createDeferred();
      const originalStatus = vi.fn(async () => {
        if (sinkState === "closed") {
          throw new Error("closed original sink");
        }
      });
      const wrongStatus = vi.fn();
      const finalDelivery = Object.assign(
        vi.fn(async () => {}),
        { ownsCompletion: () => true },
      );
      const runner = createFollowupRunner({
        typing: createFollowupTurnTestTypingController(),
        typingMode: "never",
        defaultModel: "gpt-test",
        opts: { onCompactionNotice: wrongStatus },
      });
      const run = createQueueTestRun({ prompt: "status-source", messageId: "status-source" });
      run.speechPresentation = {
        speakCommentary: false,
        ...(sinkState !== "without-hook" ? { onCompactionNotice: originalStatus } : {}),
        onError: vi.fn(),
        openRun: () => ({
          onBlockReply: () => {},
          finish: async () => {},
          abort: async () => {},
          close: () => {},
        }),
      };
      run.queuedFollowupReplyDisposition = { kind: "deliver", deliver: finalDelivery };
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        await params.opts?.onCompactionNotice?.({ text: "native-end", isCompactionNotice: true });
        started.resolve();
        await release.promise;
        return { runId: params.opts?.runId, outcome: { kind: "aborted", reason: "user" } };
      });
      const execution = runner(run);
      try {
        await withinTest(started.promise, signal);
        expect(originalStatus).toHaveBeenCalledTimes(sinkState === "without-hook" ? 0 : 2);
        expect(wrongStatus).not.toHaveBeenCalled();
        expect(finalDelivery).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await execution;
      }
    },
  );

  it.for(["before drain", "enqueue during drain", "deferred restart"] as const)(
    "keeps each queued item's observers through %s",
    async (scenario, { signal }) => {
      const firstStarted = createDeferred();
      const releaseFirst = createDeferred();
      const finished = [createDeferred(), createDeferred()];
      const executed: string[] = [];
      const message = makeAssistantMessageFixture();
      let attempts = 0;
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        if (++attempts === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          if (scenario === "deferred restart") {
            throw new FollowupRunDeferredError("reply lane busy");
          }
        }
        const item = params.followupRun.prompt;
        const runId = params.opts?.runId;
        if (!runId) {
          throw new Error("Followup execution did not bind its run ID");
        }
        executed.push(item);
        expect(params.opts?.internalEventExecution).toBe(
          params.followupRun.run.internalEventExecution,
        );
        expect(params.opts?.sourceReplyDeliveryMode).toBe(
          params.followupRun.run.sourceReplyDeliveryMode,
        );
        params.opts?.internalEventExecution?.onStarted(runId);
        await params.opts?.internalEventExecution?.onTerminal(runId, "completed");
        params.opts?.onDeliberateSilentTerminalReply?.();
        params.opts?.onAgentRunStart?.(runId);
        params.opts?.onModelSelected?.({ provider: "test", model: item, thinkLevel: undefined });
        params.opts?.prepareAssistantTranscriptMessage?.(message, item);
        await params.opts?.resolveReplyDelivery?.(1);
        params.opts?.onAgentRunTerminalOutcome?.("completed");
        // End at the execution seam without introducing transport or accounting work.
        return { runId, outcome: { kind: "aborted", reason: "user" } };
      });
      const createEventExecution = () => ({
        deliver: false as const,
        onStarted: vi.fn<SessionEventExecution["onStarted"]>(),
        onTerminal: vi.fn<SessionEventExecution["onTerminal"]>(),
      });
      const ownedEvent = createEventExecution();
      const decoyEvent = createEventExecution();
      const decoys: ReturnType<typeof createObservers>[] = [];
      const runner = () => {
        const opts = createObservers();
        decoys.push(opts);
        return createFollowupRunner({
          typing: createFollowupTurnTestTypingController(),
          typingMode: "never",
          defaultModel: "gpt-test",
          opts: {
            ...opts,
            internalEventExecution: decoyEvent,
            sourceReplyDeliveryMode: "message_tool_only",
          },
        });
      };
      const activeRunner = runner();
      const settings = createQueueSettings({ mode: "followup" });
      const observers = [createObservers(), createObservers()];
      const enqueue = (item: "B" | "C", index: number) => {
        const run = createQueueTestRun({ prompt: item, messageId: item });
        run.run.sessionKey = key;
        run.runObservers = observers[index];
        if (index === 0) {
          run.run.internalEventExecution = ownedEvent;
          run.run.sourceReplyDeliveryMode = "automatic";
        }
        run.turnAdoptionLifecycle = {
          admission: "cancel-only",
          onAdopted: () => {},
          onSettled: () => finished[index]!.resolve(),
        };
        // Production parks these enqueues behind the active reply operation.
        expect(enqueueFollowupRun(key, run, settings, "none", runner(), false)).toBe(true);
      };
      enqueue("B", 0);
      if (scenario !== "enqueue during drain") {
        enqueue("C", 1);
      }
      try {
        scheduleFollowupDrain(key, activeRunner);
        await withinTest(firstStarted.promise, signal);
        if (scenario === "enqueue during drain") {
          enqueue("C", 1);
        } else if (scenario === "deferred restart") {
          scheduleFollowupDrain(key, activeRunner);
        }
        releaseFirst.resolve();
        await withinTest(Promise.all(finished.map(({ promise }) => promise)), signal);
        await vi.runAllTimersAsync();

        expect(getExistingFollowupQueue(key)).toBeUndefined();
        expect(executed).toEqual(["B", "C"]);
        for (const [index, item] of ["B", "C"].entries()) {
          const own = observers[index]!;
          expect(own.onDeliberateSilentTerminalReply).toHaveBeenCalledOnce();
          expect(own.onAgentRunStart).toHaveBeenCalledExactlyOnceWith(`execution-${item}`);
          expect(own.onModelSelected).toHaveBeenCalledExactlyOnceWith({
            provider: "test",
            model: item,
            thinkLevel: undefined,
          });
          expect(own.onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith("completed");
          expect(own.prepareAssistantTranscriptMessage).toHaveBeenCalledExactlyOnceWith(
            message,
            item,
          );
          expect(own.resolveReplyDelivery.mock.calls).toEqual([[1], [2]]);
        }
        expect(ownedEvent.onStarted).toHaveBeenCalledExactlyOnceWith("execution-B");
        expect(ownedEvent.onTerminal).toHaveBeenCalledExactlyOnceWith("execution-B", "completed");
        expect(decoyEvent.onStarted).not.toHaveBeenCalled();
        expect(decoyEvent.onTerminal).not.toHaveBeenCalled();
        for (const decoy of decoys) {
          for (const observer of Object.values(decoy)) {
            expect(observer).not.toHaveBeenCalled();
          }
        }
      } finally {
        releaseFirst.resolve();
      }
    },
  );
});
