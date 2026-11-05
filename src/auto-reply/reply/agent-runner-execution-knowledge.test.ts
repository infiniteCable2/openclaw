import { inspect } from "node:util";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { fallbackModelAttemptOptions } from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import {
  createConfigResolutionFacts,
  serializeConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../../config/resolution-facts.js";
import * as configMatch from "../../config/runtime-config-snapshot-match.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";
import * as runnerUtils from "./agent-runner-utils.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

type KnowledgeTurnInput = Parameters<
  typeof import("./conversation-knowledge-turn.js").createReplyConversationKnowledgeTurn
>[0];

const knowledge = vi.hoisted(() => ({ create: vi.fn() }));
// mock-isolation: This execution-lifetime fixture supplies knowledge receipts without transcript workers.
vi.mock("./conversation-knowledge-turn.js", () => ({
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
  onTestFinished(() => {
    lifecycleAdmissionByOperation.delete(replyOperation);
  });
  const fragments = [{ kind: "conversation-data" as const, text: "Quoted related observations." }];
  const assertCurrent = vi.fn();
  const release = vi.fn(() => order.push("release"));
  const prepare = vi.fn();
  const prepareSnapshot = vi.fn(async () => fragments);
  const prepareHistory = vi.fn(async () => []);
  const record = vi.fn(async () => {
    order.push("record");
  });
  const knowledgeInputs: KnowledgeTurnInput[] = [];
  knowledge.create.mockImplementation((input: KnowledgeTurnInput) => {
    knowledgeInputs.push(input);
    return {
      fragments,
      assertCurrent,
      release,
      prepare,
      withPublication<T>(run: () => T): T {
        return run();
      },
      prepareSnapshot,
      prepareHistory,
      record,
    };
  });
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
  return {
    params,
    result,
    replyOperation,
    reader,
    fragments,
    assertCurrent,
    release,
    prepare,
    prepareSnapshot,
    prepareHistory,
    record,
    order,
    knowledgeInputs,
  };
}

function restoreRuntimeConfigAfterTest() {
  const previous = getRuntimeConfigSnapshot();
  const source = getRuntimeConfigSourceSnapshot();
  onTestFinished(() => {
    if (previous) {
      setRuntimeConfigSnapshot(previous, source ?? undefined);
    } else {
      clearRuntimeConfigSnapshot();
    }
  });
}

describe("actual native execution conversation knowledge lifetime", () => {
  it("binds the native config reader once, follows publications, and rebinds replaced run config", async () => {
    restoreRuntimeConfigAfterTest();
    const f = fixture();
    const runtime = { ...f.params.followupRun.run.config, gateway: { port: 19001 } };
    setRuntimeConfigSnapshot(runtime, runtime);
    f.params.followupRun.run.config = structuredClone(runtime);
    const compares = vi.spyOn(configMatch, "configSnapshotsMatch");
    const selects = vi.spyOn(runnerUtils, "resolveQueuedReplyRuntimeConfig");
    onTestFinished(() => {
      compares.mockRestore();
      selects.mockRestore();
    });
    let probeFailure: Error | undefined;
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      try {
        const input = f.knowledgeInputs[0];
        if (!input) {
          throw new Error("Native execution did not register its knowledge config reader");
        }
        const read = () => input.getRuntimeConfig();
        const initial = read();
        expect(initial).toEqual(runtime);
        expect(initial).not.toBe(runtime);
        expect(Object.isFrozen(initial.gateway)).toBe(true);
        const admittedComparisons = compares.mock.calls.length;
        const admittedSelections = selects.mock.calls.length;
        for (let index = 0; index < 100; index++) {
          expect(read()).toBe(initial);
        }
        expect(compares).toHaveBeenCalledTimes(admittedComparisons);
        expect(selects).toHaveBeenCalledTimes(admittedSelections);

        const replacement = { ...runtime, gateway: { port: 19002 } };
        setRuntimeConfigSnapshot(replacement, replacement);
        const published = read();
        expect(published).toEqual(replacement);
        expect(published).not.toBe(initial);
        expect(read()).toBe(published);

        // A fallback can replace the run's explicitly scoped configuration. Its
        // mutable values remain visible; native publications cannot overwrite it.
        const scoped = { ...runtime, gateway: { port: 19003 } };
        f.params.followupRun.run.config = scoped;
        expect(read()).toBe(scoped);
        scoped.gateway.port = 19004;
        expect(read().gateway?.port).toBe(19004);
        const latest = { ...runtime, gateway: { port: 19005 } };
        setRuntimeConfigSnapshot(latest, latest);
        expect(read()).toBe(scoped);
        return f.result;
      } catch (error) {
        probeFailure =
          error instanceof Error
            ? error
            : new Error("Knowledge config probe failed", { cause: error });
        throw error;
      }
    });
    const outcome = await executeAgentTurn(f.params);
    if (probeFailure) {
      throw probeFailure;
    }
    expect(outcome).toMatchObject({
      outcome: { kind: "settled", status: "ok" },
    });
  });

  it("keeps same-value scoped resolution provenance distinct from the native runtime", async () => {
    restoreRuntimeConfigAfterTest();
    const f = fixture();
    const runtime = { ...f.params.followupRun.run.config, gateway: { port: 19001 } };
    const scoped = structuredClone(runtime);
    setConfigResolutionFacts(
      runtime,
      createConfigResolutionFacts([], new Map([["gateway.port", "EXAMPLE_PORT_A"]])),
    );
    setConfigResolutionFacts(
      scoped,
      createConfigResolutionFacts([], new Map([["gateway.port", "EXAMPLE_PORT_B"]])),
    );
    setRuntimeConfigSnapshot(runtime, runtime);
    f.params.followupRun.run.config = scoped;
    let probeFailure: Error | undefined;
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      try {
        const input = f.knowledgeInputs[0];
        if (!input) {
          throw new Error("Native execution did not register its knowledge config reader");
        }
        const read = () => input.getRuntimeConfig();
        expect(read()).toBe(scoped);
        expect(read()).toEqual(runtime);
        expect(serializeConfigResolutionFacts(read())).not.toEqual(
          serializeConfigResolutionFacts(runtime),
        );
        scoped.gateway.port = 19002;
        expect(read().gateway?.port).toBe(19002);
        expect(runtime.gateway.port).toBe(19001);
        return f.result;
      } catch (error) {
        probeFailure =
          error instanceof Error
            ? error
            : new Error("Knowledge config probe failed", { cause: error });
        throw error;
      }
    });
    const outcome = await executeAgentTurn(f.params);
    if (probeFailure) {
      throw probeFailure;
    }
    expect(outcome).toMatchObject({
      outcome: { kind: "settled", status: "ok" },
    });
  });

  it("defers native knowledge hydration to its admitted history callback", async () => {
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
      prepareConversationContext: expect.any(Function),
    });
    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0].runtimeContextFragments).toBeUndefined();
    expect(f.prepareSnapshot).not.toHaveBeenCalled();
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
    expect(f.order).toEqual(["finish", "record", "release"]);
    expect(f.assertCurrent).toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("acquires read-only observations only when a CLI candidate is admitted", async () => {
    const provider = "claude-cli";
    const model = "claude-sonnet-4-6";
    const f = fixture(provider, model);
    // Direct execution fixtures must supply the snapshot normally bound by
    // runReplyAgent before the CLI candidate selects its actual tool route.
    f.replyOperation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(f.params.followupRun));
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
    expect(f.prepareSnapshot).toHaveBeenCalledOnce();
    expect(f.replyOperation.toolAuthorityRoute).toEqual({ provider, model });
    expect(state.runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
      modelProvider: provider,
      model,
      prompt: "fix it",
      runtimeContextFragments: f.fragments,
    });
    expect(f.record).toHaveBeenCalledOnce();
    expect(f.order).toEqual(["finish", "record", "release"]);
  });

  it("finishes speech before blocked root publication and joins publication before release", async () => {
    const f = fixture();
    const entered = createDeferredCore();
    const publication = createDeferredCore();
    f.record.mockImplementationOnce(async () => {
      f.order.push("record");
      entered.resolve();
      await publication.promise;
    });
    const running = executeAgentTurn(f.params);
    try {
      await entered.promise;
      expect(f.order).toEqual(["finish", "record"]);
      expect(f.release).not.toHaveBeenCalled();
    } finally {
      publication.resolve();
      await running;
    }
    expect(f.order).toEqual(["finish", "record", "release"]);
  });

  it.each(["native-to-cli", "cli-to-native"] as const)(
    "keeps candidate observations local during %s fallback",
    async (direction) => {
      const cli = { provider: "claude-cli", model: "claude-sonnet-4-6" };
      const native = { provider: "anthropic", model: "claude" };
      const [first, second] = direction === "native-to-cli" ? [native, cli] : [cli, native];
      const f = fixture(first.provider, first.model);
      const base = { kind: "conversation-data" as const, text: "Other retained runtime context." };
      f.params.runtimeContextFragments = [base];
      f.replyOperation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(f.params.followupRun));
      state.isCliProviderMock.mockImplementation((provider) => provider === cli.provider);
      state.runCliAgentMock.mockResolvedValue(f.result);
      const firstRunner =
        direction === "native-to-cli" ? state.runEmbeddedAgentMock : state.runCliAgentMock;
      firstRunner.mockRejectedValueOnce(new Error("synthetic fallback"));
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => {
          await expect(
            params.run(first.provider, first.model, initialFallbackAttemptOptions(params)),
          ).rejects.toThrow("synthetic fallback");
          return {
            result: await params.run(
              second.provider,
              second.model,
              fallbackModelAttemptOptions(params, "unknown"),
            ),
            ...second,
            attempts: [],
          };
        },
      );
      await expect(executeAgentTurn(f.params)).resolves.toMatchObject({
        outcome: { kind: "settled", status: "ok" },
      });
      expect(f.prepareSnapshot).toHaveBeenCalledOnce();
      expect(state.runCliAgentMock.mock.calls[0]?.[0].runtimeContextFragments).toEqual([
        base,
        ...f.fragments,
      ]);
      expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0].runtimeContextFragments).toEqual([base]);
      expect(f.params.runtimeContextFragments).toEqual([base]);
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

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
