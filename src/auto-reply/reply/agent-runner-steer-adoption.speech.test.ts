import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplySpeechPresentation } from "../../talk/reply-speech-presentation.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { createReplyOperation } from "./reply-run-registry.operation.js";
import { testing } from "./reply-run-registry.test-support.js";
import { resolveReplySpeechOutputOwner } from "./reply-speech-presentation.js";
import { createTypingSignaler } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

const mocks = vi.hoisted(() => ({
  parked: { admit: vi.fn(), fallback: vi.fn(), accepted: vi.fn(), consume: vi.fn() },
  authority: vi.fn(),
}));
// mock-isolation: Exercise the actual reply operation and steering admission, not a queue drain.
vi.mock("./queue.js", async () => ({
  ...(await import("./queue/types.js")),
  parkSteerCandidate: () => mocks.parked,
  scheduleFollowupDrain() {},
}));
// mock-isolation: Owner-clear scheduling is outside the synchronous output identity contract.
vi.mock("./agent-runner-core.js", () => ({ scheduleFollowupDrainAfterReplyOperationClear() {} }));
// mock-isolation: Stop at the real policy boundary without invoking a provider or worker.
vi.mock("./agent-runner-fallback-authority.js", () => ({
  resolveReplySteeringAuthority: mocks.authority,
}));

function source(outputOwner?: object) {
  return createReplySpeechPresentation({
    outputOwner,
    assertOutputCurrent() {},
    onResult() {},
    onError() {},
    logger: { warn() {} },
  });
}

describe("native speech output steering ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parked.admit.mockResolvedValue("steer");
    mocks.authority.mockRejectedValue(new Error("Native policy preparation reached"));
  });
  afterEach(() => testing.resetReplyRunRegistry());

  it("binds the actual operation once and cannot retarget it after close", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:example:dialogue",
      sessionId: "example-session",
      resetTriggered: false,
    });
    const outputOwner = {};
    operation.bindSpeechOutputOwner(outputOwner);
    operation.bindSpeechOutputOwner(outputOwner);
    expect(operation.speechOutputOwner).toBe(outputOwner);
    expect(() => operation.bindSpeechOutputOwner({})).toThrow("changed");
    expect(() => operation.bindSpeechOutputOwner(undefined)).toThrow("changed");
    operation.complete();
    expect(() => operation.bindSpeechOutputOwner(outputOwner)).toThrow("unavailable");
  });

  it("keeps an ordinary native turn non-speech instead of upgrading it later", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:example:dialogue",
      sessionId: "example-session",
      resetTriggered: false,
    });
    operation.bindSpeechOutputOwner(undefined);
    operation.bindSpeechOutputOwner(undefined);
    expect(() => operation.bindSpeechOutputOwner({})).toThrow("changed");
  });

  it.each(["different-output", "same-output", "native-text"] as const)(
    "uses the native follow-up policy for %s without retargeting active output",
    async (variant) => {
      const operation = createReplyOperation({
        sessionKey: "agent:example:dialogue",
        sessionId: "example-session",
        resetTriggered: false,
      });
      const outputOwner = {};
      const incoming = variant === "native-text" ? undefined : source(outputOwner);
      operation.bindSpeechOutputOwner(
        variant === "different-output" ? {} : resolveReplySpeechOutputOwner(incoming),
      );
      operation.attachBackend({
        kind: "embedded",
        runId: "example-run",
        cancel() {},
        messageInjection: { isAvailable: () => true, queueMessage: async () => {} },
      });
      operation.setPhase("running");
      const followupRun = createQueueTestRun({ prompt: "A genuine addition." });
      followupRun.speechPresentation = incoming;
      followupRun.assertSourceCurrent = vi.fn();
      const typing = createTypingController({});
      const runState: ReplyOperationRunState = {};
      const invocation = runActiveReplySteer({
        followupRun,
        opts: {},
        providedReplyOperation: operation,
        queueKey: operation.key,
        releaseAdmissionTicket() {},
        replyOperationRunState: runState,
        resolvedQueue: { mode: "steer" },
        restartRecoverySourceTurnId: undefined,
        runFollowup: async () => {},
        sessionCtx: {},
        sessionKey: operation.key,
        touchActiveSessionEntry: async () => {},
        typing,
        typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
      });
      if (variant === "different-output") {
        await expect(invocation).resolves.toBe("handled");
        expect(mocks.parked.fallback).toHaveBeenCalledOnce();
        expect(mocks.authority).not.toHaveBeenCalled();
        expect(runState.admission).toEqual({ status: "accepted", mode: "followup" });
      } else {
        await expect(invocation).rejects.toThrow("Native policy preparation reached");
        expect(mocks.authority).toHaveBeenCalledOnce();
      }
      expect(followupRun.assertSourceCurrent).toHaveBeenCalled();
    },
  );

  it("retains one connection identity across distinct turn-owned presentations", () => {
    const outputOwner = {};
    const first = source(outputOwner);
    const second = source(outputOwner);
    expect(first).not.toBe(second);
    expect(resolveReplySpeechOutputOwner(first)).toBe(resolveReplySpeechOutputOwner(second));
    expect(resolveReplySpeechOutputOwner(source())).not.toBe(
      resolveReplySpeechOutputOwner(source()),
    );
  });
});
