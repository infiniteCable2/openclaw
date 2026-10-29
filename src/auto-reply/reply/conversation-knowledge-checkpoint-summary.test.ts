import { beforeEach, describe, expect, it, vi } from "vitest";
import { requiresCompleteCompactionSummary } from "../../agents/compaction-summary-coverage.js";
import { prepareCompactionBudgetPreflight } from "../../agents/embedded-agent-runner/compaction-budget-preflight.js";
import type { StreamFn } from "../../agents/runtime/index.js";
import type { SessionModelUsageSink } from "../../agents/sessions/compaction/runtime.js";
import {
  planConversationKnowledgeCheckpointSummary,
  prepareConversationKnowledgeCheckpointSummary,
} from "./conversation-knowledge-checkpoint-summary.js";

const summary = vi.hoisted(() => vi.fn());
// mock-isolation: Only replace the provider-bound summarizer; native budget and complete-summary scope remain real.
vi.mock("../../agents/compaction.js", () => ({ summarizeInStages: summary }));
// mock-isolation: Use the identical pure planner without starting compiled workers in this focused adapter test.
vi.mock("../../agents/compaction-planning-worker.js", async () => {
  const { computeAdaptiveChunkRatio } = await import("../../agents/compaction-planning.js");
  return {
    computeAdaptiveChunkRatioWithWorker: async (
      params: Parameters<
        typeof import("../../agents/compaction-planning-worker.js").computeAdaptiveChunkRatioWithWorker
      >[0],
    ) => computeAdaptiveChunkRatio(params.messages, params.contextWindow),
  };
});

function fixture() {
  return {
    contributions: ["oldest", "middle", "latest"].map((contributionId) => ({
      contributionId,
      complete: true as const,
      text: `Conversation ${contributionId}:\nuser: "${"x".repeat(2_000)}"`,
    })),
    previousSummary: "An earlier retained decision.",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    budget: {
      contextTokenBudget: 1_000,
      prompt: "",
      systemPrompt: "An example agent.",
      toolSchemaTokens: 0,
    },
    native: {
      model: {
        id: "summary-example",
        name: "Summary example",
        api: "openai-completions" as const,
        provider: "openai",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 2_000,
      },
      apiKey: "",
      signal: new AbortController().signal,
      reserveTokens: 2_000,
      contextWindow: 128_000,
      customInstructions: "Preserve decisions and unresolved questions.",
      streamFn: vi.fn<StreamFn>(),
      usageSink: vi.fn<SessionModelUsageSink>(),
    },
  };
}

beforeEach(() => {
  summary.mockReset().mockImplementation(async () => {
    expect(requiresCompleteCompactionSummary()).toBe(true);
    return "The earlier decision and completed observations are preserved.";
  });
});

describe("native root checkpoint summary adapter", () => {
  it("uses native token pressure and retains complete recent contributions", async () => {
    const params = fixture();
    const original = structuredClone(params.contributions);
    const plan = planConversationKnowledgeCheckpointSummary(params);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") {
      throw new Error("Expected native token pressure");
    }
    expect(plan.coveredContributionIds).toEqual(["oldest", "middle"]);
    expect(plan.retainedContributionIds).toEqual(["latest"]);
    expect(plan.messages.map((message) => message.content)).toEqual(
      params.contributions.slice(0, 2).map((entry) => entry.text),
    );
    const candidate = await prepareConversationKnowledgeCheckpointSummary(params);
    expect(candidate).toMatchObject({
      kind: "candidate",
      coveredContributionIds: ["oldest", "middle"],
      retainedContributionIds: ["latest"],
    });
    expect(summary).toHaveBeenCalledOnce();
    expect(summary).toHaveBeenCalledWith(
      expect.objectContaining({
        ...params.native,
        previousSummary: params.previousSummary,
        messages: plan.messages,
      }),
    );
    expect(params.contributions).toEqual(original);
    expect(requiresCompleteCompactionSummary()).toBe(false);
    expect(params.native.streamFn).not.toHaveBeenCalled();
  });

  it("does not summarize below native pressure or when native automatic compaction is disabled", async () => {
    const params = fixture();
    params.budget.contextTokenBudget = 20_000;
    expect(await prepareConversationKnowledgeCheckpointSummary(params)).toEqual({
      kind: "not-needed",
    });
    params.budget.contextTokenBudget = 1_000;
    params.settings.enabled = false;
    expect(await prepareConversationKnowledgeCheckpointSummary(params)).toEqual({
      kind: "not-needed",
    });
    expect(summary).not.toHaveBeenCalled();
  });

  it("honors native prompt and tool token pressure instead of using a byte trigger", () => {
    const params = fixture();
    params.budget.contextTokenBudget = 20_000;
    params.budget.toolSchemaTokens = 20_000;
    const plan = planConversationKnowledgeCheckpointSummary({
      ...params,
      previousSummary: undefined,
    });
    const native = prepareCompactionBudgetPreflight({
      ...params.budget,
      reserveTokens: params.settings.reserveTokens,
      messages: params.contributions.map((entry) => ({
        role: "user",
        content: entry.text,
        timestamp: 0,
      })),
    });
    expect(plan).toMatchObject({
      kind: "ready",
      estimatedTokensBefore: native.estimatedPromptTokens,
    });
  });

  it("defers rather than claiming partial coverage or cutting the requested recent tail", async () => {
    const params = fixture();
    params.settings.keepRecentTokens = 20_000;
    expect(await prepareConversationKnowledgeCheckpointSummary(params)).toEqual({
      kind: "deferred",
      reason: "no-whole-prefix",
    });
    Object.assign(params.contributions[0]!, { complete: false });
    expect(() => planConversationKnowledgeCheckpointSummary(params)).toThrow(
      "complete unique contributions",
    );
    expect(summary).not.toHaveBeenCalled();
  });

  it("defers an indivisible oversized contribution without dropping text", async () => {
    const params = fixture();
    params.contributions[0]!.text = "x".repeat(600_000);
    expect(await prepareConversationKnowledgeCheckpointSummary(params)).toEqual({
      kind: "deferred",
      reason: "oversized-contribution",
    });
    expect(params.contributions[0]!.text).toHaveLength(600_000);
    expect(summary).not.toHaveBeenCalled();
  });

  it("uses the configured native provider first and passes its whole prefix and prior summary", async () => {
    const params = fixture();
    const provider = {
      id: "example",
      label: "Example",
      summarize: vi.fn(async () => {
        expect(requiresCompleteCompactionSummary()).toBe(true);
        return "A complete provider summary.";
      }),
    };
    expect(
      await prepareConversationKnowledgeCheckpointSummary({ ...params, provider }),
    ).toMatchObject({ kind: "candidate" });
    expect(provider.summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        previousSummary: params.previousSummary,
        signal: params.native.signal,
      }),
    );
    expect(summary).not.toHaveBeenCalled();
    provider.summarize.mockRejectedValueOnce(new Error("Provider unavailable"));
    expect(
      await prepareConversationKnowledgeCheckpointSummary({ ...params, provider }),
    ).toMatchObject({ kind: "candidate" });
    expect(summary).toHaveBeenCalledOnce();
  });

  it.each([
    "",
    "No prior history.",
    "Earlier text. [Partial summary: later chunks unavailable]",
    "Text\n\n[Compaction summary truncated to fit budget]",
  ])("refuses an incomplete summary %j", async (text) => {
    summary.mockResolvedValueOnce(text);
    const params = fixture();
    expect(await prepareConversationKnowledgeCheckpointSummary(params)).toEqual({
      kind: "deferred",
      reason: "summary-unavailable",
    });
    expect(params.previousSummary).toBe("An earlier retained decision.");
  });

  it("preserves the old checkpoint on a failure, cancellation or summary that does not fit", async () => {
    const params = fixture();
    summary.mockRejectedValueOnce(new Error("Second chunk unavailable"));
    await expect(prepareConversationKnowledgeCheckpointSummary(params)).rejects.toThrow(
      "Second chunk unavailable",
    );
    summary.mockResolvedValueOnce("x".repeat(10_000));
    expect(await prepareConversationKnowledgeCheckpointSummary(params)).toEqual({
      kind: "deferred",
      reason: "summary-still-over-budget",
    });
    const controller = new AbortController();
    controller.abort(new Error("Owner closed"));
    await expect(
      prepareConversationKnowledgeCheckpointSummary({
        ...params,
        native: { ...params.native, signal: controller.signal },
      }),
    ).rejects.toThrow("Owner closed");
    expect(params.previousSummary).toBe("An earlier retained decision.");
  });
});
