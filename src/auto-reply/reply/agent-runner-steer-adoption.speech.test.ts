import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { createReplySpeechPresentation } from "../../talk/reply-speech-presentation.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import {
  attachSteerBackend,
  createSteerParams,
} from "./agent-runner-steer-adoption.test-support.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { resolveReplySpeechOutputOwner } from "./reply-speech-presentation.js";

const mocks = vi.hoisted(() => ({ prepareDelivery: vi.fn() }));
// mock-isolation: Owner-clear scheduling is outside the synchronous output identity contract.
vi.mock("./agent-runner-core.js", () => ({ scheduleFollowupDrainAfterReplyOperationClear() {} }));
// mock-isolation: Keep the real controller/mailbox admission, stopping before delivery preparation.
vi.mock("./steering-delivery-preparation.js", () => ({
  prepareSteeringDelivery: mocks.prepareDelivery,
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
    mocks.prepareDelivery.mockImplementation(() => {
      throw new Error("Native policy preparation reached");
    });
  });
  afterEach(() => testing.resetSessionControllerForTest());

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
      attachSteerBackend(operation, "test-policy", {
        runId: "example-run",
        queueMessage: async () => {},
      });
      const followupRun = createQueueTestRun(
        { prompt: "A genuine addition.", messageId: "new-human-input" },
        { sessionKey: operation.key, sessionId: operation.sessionId },
      );
      followupRun.speechPresentation = incoming;
      followupRun.assertSourceCurrent = vi.fn<() => void>();
      const runState: ReplyOperationRunState = {};
      const invocation = runActiveReplySteer(
        createSteerParams(operation.key, followupRun, operation, {
          replyOperationRunState: runState,
          runFollowup: async () => {},
        }),
      );
      try {
        if (variant === "different-output") {
          await expect(invocation).resolves.toBe("handled");
          expect(getExistingFollowupQueue(operation.key)?.items).toContain(followupRun);
          expect(mocks.prepareDelivery).not.toHaveBeenCalled();
          expect(runState.admission).toMatchObject({ status: "accepted", mode: "followup" });
        } else {
          await expect(invocation).rejects.toThrow("Native policy preparation reached");
          expect(mocks.prepareDelivery).toHaveBeenCalledOnce();
        }
      } finally {
        clearSessionQueues([operation.key]);
        operation.complete();
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
