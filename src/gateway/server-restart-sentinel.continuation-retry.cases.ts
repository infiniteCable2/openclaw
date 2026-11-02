import { expect, it, type Mock } from "vitest";
import { buildReplyRunShuttingDownPayload } from "../auto-reply/reply/get-reply-run-queue.js";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import {
  expectContinuationDispatchFields as assertContinuationDispatchFields,
  expectMockCallFields,
  expectRecordFields,
  lastMockCallArg,
} from "./server-restart-sentinel.test-support.js";

export type RestartSentinelContinuationDispatchParams = Parameters<
  typeof import("../channels/turn/lifecycle.js").dispatchAssembledChannelTurn
>[0] & {
  deliver: (payload: { text?: string; replyToId?: string | null }) => Promise<void>;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
};

type RestartContinuationRetryFixture = {
  mocks: {
    recordInboundSessionAndDispatchReply: Mock<
      (params: RestartSentinelContinuationDispatchParams) => Promise<void>
    >;
    enqueueSessionDelivery: Pick<Mock, "mock" | "mockRejectedValueOnce">;
    resolveOutboundTarget: Pick<Mock, "mockReturnValueOnce">;
    deliverOutboundPayloads: Pick<Mock, "mock">;
    logWarn: Pick<Mock, "mock">;
    enqueueSessionEvent: Pick<Mock, "mock">;
    enqueueDeliveryOnce: Pick<Mock, "mock">;
    clearSentinel: Pick<Mock, "mock">;
    drainPendingSessionDelivery: Pick<Mock, "mock">;
  };
  mockRestartContinuation: (
    continuation: NonNullable<RestartSentinelPayload["continuation"]>,
    threadId?: string,
    revision?: number,
  ) => void;
  wakeRestartSentinel: () => ReturnType<
    typeof import("./server-restart-sentinel.js").scheduleRestartSentinelWake
  >;
};

// Register inside the existing owner suite so its native queue fixture and hooks stay unchanged.
export function registerRestartContinuationRetryCases({
  mocks,
  mockRestartContinuation,
  wakeRestartSentinel,
}: RestartContinuationRetryFixture): void {
  const expectContinuationDispatchFields = assertContinuationDispatchFields.bind(
    null,
    mocks.recordInboundSessionAndDispatchReply,
  );
  it("logs and continues when continuation dispatch reports a delivery error", async () => {
    mockRestartContinuation({
      kind: "agentTurn",
      message: "continue",
    });
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(
      async (params: { onDispatchError: (err: unknown, info: { kind: string }) => void }) => {
        params.onDispatchError(new Error("route failed"), { kind: "final" });
      },
    );

    await wakeRestartSentinel();

    expect(mocks.logWarn.mock.calls[0]).toEqual([
      "restart continuation dispatch failed during final: Error: route failed",
      {
        sessionKey: "agent:main:main",
      },
    ]);
    expect(mocks.logWarn.mock.calls[1]?.[0]).toMatch(
      /^restart continuation: retry failed for entry [0-9a-f]{64}: route failed$/,
    );
  });

  it.each(["legacy-en", "de-DE"] as const)(
    "retries restart continuations when the previous run is still shutting down (%s)",
    async (language) => {
      const busyPayload =
        language === "legacy-en"
          ? { text: "⚠️ Previous run is still shutting down. Please try again in a moment." }
          : buildReplyRunShuttingDownPayload(language);
      const busyReply = busyPayload.text;
      let attempt = 0;
      mockRestartContinuation({ kind: "agentTurn", message: "continue" }, undefined, 123);
      mocks.recordInboundSessionAndDispatchReply.mockImplementation(async (params) => {
        attempt += 1;
        if (attempt <= 2) {
          await params.deliver(busyPayload);
          return;
        }
        await params.deliver({
          text: "done",
          replyToId: String(params.ctxPayload.MessageSid),
        });
      });

      await wakeRestartSentinel();

      expectMockCallFields(mocks.enqueueSessionDelivery, {
        maxRetries: 20,
      });
      expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(3);
      expectContinuationDispatchFields(
        {},
        { MessageSid: "restart-sentinel:agent:main:main:agentTurn:123" },
        0,
      );
      expectContinuationDispatchFields(
        {},
        { MessageSid: "restart-sentinel:agent:main:main:agentTurn:123:retry:2" },
        2,
      );
      const deliveredBusyReply = (
        mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
          [{ payloads?: Array<{ text?: string }> }]
        >
      ).some(([call]) => call.payloads?.some((payload) => payload.text === busyReply) === true);
      expect(deliveredBusyReply).toBe(false);
      const deliveredFinalReply = (
        mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
          [{ payloads?: Array<{ text?: string }> }]
        >
      ).some(([call]) => call.payloads?.some((payload) => payload.text === "done") === true);
      expect(deliveredFinalReply).toBe(false);
      expectRecordFields(lastMockCallArg(mocks.deliverOutboundPayloads), {
        payloads: [{ text: "restart message" }],
      });
      expect(mocks.logWarn).toHaveBeenCalledTimes(2);
      for (const [message] of mocks.logWarn.mock.calls) {
        expect(message).toMatch(
          /^restart continuation: retry failed for entry [0-9a-f]{64}: restart continuation deferred because previous run is still shutting down$/,
        );
      }
      expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    },
  );

  it("records an unroutable continuation without a diagnostic wake", async () => {
    mockRestartContinuation({ kind: "agentTurn", message: "continue" }, "thread-42");
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error("missing route"),
    });

    await wakeRestartSentinel();

    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(mocks.clearSentinel).toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("lifecycle notice skipped: no delivery target", {
      runId: undefined,
    });
  });

  it("keeps the sentinel file when durable continuation handoff fails", async () => {
    mockRestartContinuation({
      kind: "agentTurn",
      message: "continue",
    });
    mocks.enqueueSessionDelivery.mockRejectedValueOnce(new Error("queue write failed"));

    await wakeRestartSentinel();

    expect(mocks.clearSentinel).not.toHaveBeenCalled();
    expect(mocks.drainPendingSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("startup task failed", {
      source: "restart-sentinel",
      sessionKey: "agent:main:main",
      reason: "queue write failed",
    });
  });
}
