import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GetReplyOptions, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { vi, type Mock } from "vitest";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

type DeliverFn = (payload: ReplyPayload, info: { kind: string }) => Promise<unknown>;

type StreamingMocks = {
  sendMessageMatrixMock: Mock;
  sendSingleTextMessageMatrixMock: Mock;
  editMessageMatrixMock: Mock;
  deliverMatrixRepliesMock: Mock;
  createMockMatrixDeliveryResult: () => Record<string, unknown>;
};

export function createMatrixStreamingTestHarness(
  mocks: StreamingMocks,
  opts?: {
    replyToMode?: "off" | "first" | "all" | "batched";
    threadReplies?: "inbound" | "always";
    blockStreamingEnabled?: boolean;
    streaming?: "partial" | "quiet" | "progress" | "off";
    previewToolProgressEnabled?: boolean;
    accountConfig?: import("../../types.js").MatrixConfig;
    agentId?: string;
    isDirectMessage?: boolean;
  },
) {
  const {
    sendMessageMatrixMock,
    sendSingleTextMessageMatrixMock,
    editMessageMatrixMock,
    deliverMatrixRepliesMock,
    createMockMatrixDeliveryResult,
  } = mocks;
  let capturedDeliver: DeliverFn | undefined;
  let capturedOnError: ((error: unknown, info: { kind: string }) => void) | undefined;
  let capturedReplyOpts: GetReplyOptions | undefined;
  const { promise: captured, resolve: resolveCaptured } = createDeferred<void>();
  const notifyCaptured = () => {
    if (capturedDeliver && capturedReplyOpts) {
      resolveCaptured();
    }
  };
  // Gate that keeps the handler's model run alive until the test releases it.
  const { promise: runGate, resolve: resolveRunGate } = createDeferred<void>();

  sendMessageMatrixMock.mockReset().mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
  sendSingleTextMessageMatrixMock
    .mockReset()
    .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
  editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
  deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());

  const redactEventMock = vi.fn(async () => "$redacted");
  const logVerboseMessage = vi.fn();

  const { handler } = createMatrixHandlerTestHarness({
    streaming: opts?.streaming ?? "quiet",
    accountConfig: opts?.accountConfig,
    isDirectMessage: opts?.isDirectMessage,
    roomsConfig:
      opts?.isDirectMessage === false
        ? { "!room:example.org": { requireMention: false } }
        : undefined,
    resolveAgentRoute: () => ({
      agentId: opts?.agentId ?? "ops",
      channel: "matrix",
      accountId: "ops",
      sessionKey: `agent:${opts?.agentId ?? "ops"}:main`,
      mainSessionKey: `agent:${opts?.agentId ?? "ops"}:main`,
      matchedBy: "binding.account" as const,
    }),
    previewToolProgressEnabled: opts?.previewToolProgressEnabled ?? false,
    blockStreamingEnabled: opts?.blockStreamingEnabled ?? false,
    replyToMode: opts?.replyToMode ?? "off",
    threadReplies: opts?.threadReplies,
    client: { redactEvent: redactEventMock },
    logVerboseMessage,
    createReplyDispatcherWithTyping: (params: Record<string, unknown> | undefined) => {
      capturedDeliver = params?.deliver as DeliverFn | undefined;
      capturedOnError = params?.onError as typeof capturedOnError;
      notifyCaptured();
      return {
        dispatcher: {
          markComplete: () => {},
          waitForIdle: async () => {},
        },
        replyOptions: {},
        markDispatchIdle: () => {},
        markRunComplete: () => {},
      };
    },
    dispatchInboundMessage: vi.fn(async (args: { replyOptions?: GetReplyOptions }) => {
      capturedReplyOpts = args?.replyOptions;
      notifyCaptured();
      // Block until the test is done exercising callbacks.
      await runGate;
      return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
    }) as never,
  });

  const dispatch = async () => {
    // Start handler without awaiting — it blocks on runGate.
    const handlerDone = handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
    );
    await Promise.race([
      captured,
      handlerDone.then(() => {
        throw new Error("Matrix handler completed before reply dispatch was captured");
      }),
    ]);
    return {
      deliver: capturedDeliver!,
      onError: capturedOnError!,
      opts: capturedReplyOpts!,
      // Release the run gate and wait for the handler to finish
      // (including the finally block that stops the draft stream).
      finish: async () => {
        resolveRunGate();
        await handlerDone;
      },
    };
  };

  return { dispatch, redactEventMock, logVerboseMessage };
}
