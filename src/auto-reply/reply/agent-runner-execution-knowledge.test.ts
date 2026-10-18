import { inspect } from "node:util";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

const knowledge = vi.hoisted(() => ({ create: vi.fn() }));
// mock-isolation: This execution-lifetime fixture supplies knowledge receipts without transcript workers.
vi.mock("./conversation-knowledge.js", () => ({
  createReplyConversationKnowledgeTurn: knowledge.create,
}));

const state = await setupAgentRunnerExecutionTestState();
const { lifecycleAdmissionByOperation } = await import("./reply-run-registry.state.js");
const { executeAgentTurn } = await import("./agent-runner-execution.js");

beforeEach(() => {
  knowledge.create.mockReset();
});

function fixture(provider = "anthropic", model = "claude") {
  const order: string[] = [];
  const followupRun = createFollowupRun();
  followupRun.run.provider = provider;
  followupRun.run.model = model;
  followupRun.run.config = { agents: { entries: { main: { conversationMode: "branches" } } } };
  const { replyOperation } = createMockReplyOperation();
  const reader: SessionEntryCohortReader = {
    database: { agentId: "main", path: "/synthetic/agent.sqlite", env: {} },
    sessionKey: "main",
    logicalAgentId: "main",
    storePaths: ["/synthetic/agent.sqlite"],
    assertCurrent() {},
    async withRead() {
      throw new Error("The mocked knowledge adapter must own consumption");
    },
  };
  lifecycleAdmissionByOperation.set(replyOperation, { reader });
  onTestFinished(() => lifecycleAdmissionByOperation.delete(replyOperation));
  const fragments = [{ kind: "conversation-data" as const, text: "Quoted related observations." }];
  const assertCurrent = vi.fn();
  const release = vi.fn(() => order.push("release"));
  const prepare = vi.fn();
  const record = vi.fn(async () => {
    order.push("record");
  });
  knowledge.create.mockReturnValue({ fragments, assertCurrent, release, prepare, record });
  followupRun.speechPresentation = {
    speakCommentary: true,
    openRun: () => ({
      onBlockReply() {},
      async finish() {
        order.push("finish");
      },
      async abort() {},
      close() {},
    }),
    onError() {},
  };
  const params = createMinimalRunAgentTurnParams({
    followupRun,
    replyOperation,
    opts: { runId: "run-knowledge" },
  });
  const result = {
    payloads: [{ text: "The requested answer." }],
    meta: {
      agentMeta: {
        terminalReceipt: {
          runId: "run-knowledge",
          sessionId: followupRun.run.sessionId,
          turnId: "turn-original",
          requested: { provider, model },
          effective: { provider, model, responseModel: model },
          successfulToolNames: [],
          rerouted: false,
          assistantTranscriptIdempotencyKey: "run-knowledge:assistant",
        },
      },
    },
  };
  state.runEmbeddedAgentMock.mockResolvedValue(result);
  return { params, result, reader, fragments, assertCurrent, release, prepare, record, order };
}

describe("actual native execution conversation knowledge lifetime", () => {
  it("passes neutral fragments without rewriting input and reports before final speech output", async () => {
    const f = fixture();
    await expect(executeAgentTurn(f.params)).resolves.toMatchObject({
      outcome: { kind: "settled", status: "ok" },
    });
    expect(knowledge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: expect.objectContaining({ replyOperation: f.params.replyOperation }),
      }),
    );
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: "fix it",
      runtimeContextFragments: f.fragments,
    });
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "settled",
        status: "ok",
        result: expect.objectContaining({
          payloads: f.result.payloads,
          meta: expect.objectContaining(f.result.meta),
        }),
      }),
    );
    expect(f.order).toEqual(["record", "finish", "release"]);
    expect(f.assertCurrent).toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("passes the same native neutral fragments to a CLI candidate", async () => {
    const provider = "claude-cli";
    const model = "claude-sonnet-4-6";
    const f = fixture(provider, model);
    state.isCliProviderMock.mockImplementation((candidate) => candidate === provider);
    // Select an actual configured CLI backend through the same native fallback
    // contract as the existing CLI execution fixtures, not an HTTP provider
    // mislabeled as CLI by an unconditional predicate.
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
      provider,
      model,
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValue(f.result);
    const { defaultRuntime } = await import("../../runtime.js");
    const priorErrors = vi.mocked(defaultRuntime.error).mock.calls.length;
    const result = await executeAgentTurn(f.params);
    expect(
      result,
      `Actual native CLI failure: ${inspect(
        {
          outcome: result.outcome,
          errors: vi.mocked(defaultRuntime.error).mock.calls.slice(priorErrors),
        },
        { depth: 8 },
      )}`,
    ).toMatchObject({
      outcome: { kind: "settled", status: "ok" },
    });
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(state.runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
      modelProvider: provider,
      model,
      prompt: "fix it",
      runtimeContextFragments: f.fragments,
    });
    expect(f.record).toHaveBeenCalledOnce();
    expect(f.order).toEqual(["record", "finish", "release"]);
  });

  it("passes native cancellation to the knowledge owner and still joins its lifetime", async () => {
    const f = fixture();
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (params: RunEmbeddedAgentInternalParams) => {
        params.onDeferredLifecycleAbort?.();
        params.abortSignal?.throwIfAborted();
      },
    );
    await expect(executeAgentTurn(f.params)).resolves.toMatchObject({
      outcome: { kind: "aborted" },
    });
    expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "aborted" }));
    expect(f.release).toHaveBeenCalledOnce();
  });
});
