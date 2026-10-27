import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompactHooksSessionFixture } from "./compact.hooks.fixture.test-support.js";
import {
  attemptServerEndpointCompactionMock,
  createAgentSessionMock,
  hookRunner,
  loadCompactHooksHarness,
  resolveContextWindowInfoMock,
  resolveModelAsyncMock,
  resolveModelMock,
  sessionAutomaticCompactionMock,
  sessionCompactImpl,
  sessionManualCompactionMock,
  sessionMessages,
  triggerInternalHookMock,
} from "./compact.hooks.harness.js";

const sessionKey = "agent:main:compaction-budget";
const fixture = useCompactHooksSessionFixture(sessionKey);
let compact: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
let storePath: string;
let prepared: Awaited<ReturnType<typeof fixture.prepareSession>>;

beforeAll(async () => {
  compact = (await loadCompactHooksHarness()).compactEmbeddedAgentSessionDirect;
  storePath = await fixture.prepare();
});
beforeEach(async () => {
  prepared = await fixture.prepareSession();
  hookRunner.hasHooks.mockReturnValue(true);
});

function args() {
  return {
    agentId: "main",
    sessionId: prepared.sessionId,
    sessionKey,
    sessionFile: sessionKey,
    sessionTarget: { agentId: "main", sessionId: prepared.sessionId, sessionKey, storePath },
    workspaceDir: prepared.workspaceDir,
    customInstructions: "focus on decisions",
    trigger: "budget" as const,
    provider: "openai",
    model: "foreground-model",
    budgetPreflight: { prompt: "Continue with this request." },
  };
}

describe("native ingestion-budget compaction dispatch", () => {
  it("does not admit pending packets against a merely prospective tool-result reduction", async () => {
    const { prepareCompactionBudgetPreflight } = await import("./compaction-budget-preflight.js");
    const history = [
      {
        role: "toolResult" as const,
        toolCallId: "large",
        toolName: "synthetic",
        // Native tool pressure floors text at two chars/token, then adds 20%
        // safety. At 230k chars its overflow remains comfortably smaller than
        // the reduction to the native 32k live-result cap. 700k instead needs
        // compaction as well and cannot exercise the truncate-only route.
        content: [{ type: "text" as const, text: "x".repeat(230_000) }],
        isError: false,
        timestamp: 1,
      },
    ];
    const pending = [
      {
        role: "custom" as const,
        customType: "synthetic-observation",
        content: "Quoted fact.",
        display: false,
        timestamp: 2,
      },
    ];
    const pressure = prepareCompactionBudgetPreflight({
      messages: history,
      pendingMessages: pending,
      prompt: "Continue.",
      contextTokenBudget: 128_000,
      reserveTokens: 16_384,
    });
    expect(pressure.route).toBe("truncate_tool_results_only");
    expect(pressure.shouldCompact).toBe(false);
    expect(pressure.overflowTokens).toBeGreaterThan(0);
    sessionMessages.splice(0, sessionMessages.length, ...history);
    const original = structuredClone(sessionMessages);
    const onDecision = vi.fn();
    const result = await compact({
      ...args(),
      budgetPreflight: {
        prompt: "Continue.",
        pendingMessages: pending,
        checkOnly: true,
        onDecision,
      },
    });
    expect(result).toMatchObject({ ok: true, compacted: false });
    expect(onDecision).toHaveBeenCalledExactlyOnceWith(false);
    expect(sessionMessages).toEqual(original);
    expect(sessionCompactImpl).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeCompaction).not.toHaveBeenCalled();
  });
  it("reports an oversized prospective check without summary dispatch, hooks, or durable insertion", async () => {
    const pending = [
      {
        role: "custom" as const,
        customType: "synthetic-observation",
        content: "Pending observation. ".repeat(80_000),
        display: false,
        timestamp: 3,
      },
    ];
    const original = structuredClone(sessionMessages);
    const onDecision = vi.fn();
    const result = await compact({
      ...args(),
      budgetPreflight: {
        prompt: "Continue with this request.",
        pendingMessages: pending,
        checkOnly: true,
        onDecision,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      compacted: false,
      reason: "native budget admission checked without compaction",
    });
    expect(onDecision).toHaveBeenCalledExactlyOnceWith(false);
    expect(sessionMessages).toEqual(original);
    expect(sessionAutomaticCompactionMock).not.toHaveBeenCalled();
    expect(sessionManualCompactionMock).not.toHaveBeenCalled();
    expect(sessionCompactImpl).not.toHaveBeenCalled();
    expect(attemptServerEndpointCompactionMock).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeCompaction).not.toHaveBeenCalled();
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(triggerInternalHookMock).not.toHaveBeenCalled();
  });
  it("skips ingestion-budget compaction before dispatch and hooks when prepared context fits", async () => {
    const result = await compact(args());
    expect(result).toMatchObject({
      ok: true,
      compacted: false,
      reason: expect.stringContaining("below threshold"),
    });
    expect(sessionAutomaticCompactionMock).not.toHaveBeenCalled();
    expect(sessionManualCompactionMock).not.toHaveBeenCalled();
    expect(sessionCompactImpl).not.toHaveBeenCalled();
    expect(attemptServerEndpointCompactionMock).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeCompaction).not.toHaveBeenCalled();
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(triggerInternalHookMock).not.toHaveBeenCalled();
  });

  it("dispatches normal native compaction when actual ingestion history exceeds its token budget", async () => {
    sessionMessages.splice(0, sessionMessages.length, {
      role: "user",
      content: "Unprocessed conversation observations. ".repeat(30_000),
      timestamp: 1,
    });
    const result = await compact(args());
    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(sessionAutomaticCompactionMock).toHaveBeenCalledOnce();
    expect(sessionCompactImpl).toHaveBeenCalledOnce();
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledOnce();
  });

  it.each([
    { foregroundWindow: 1_000_000, summaryWindow: 32_000, compacted: false },
    { foregroundWindow: 32_000, summaryWindow: 1_000_000, compacted: true },
  ])(
    "checks the $foregroundWindow-token foreground independently of the $summaryWindow-token summarizer",
    async ({ foregroundWindow, summaryWindow, compacted }) => {
      const resolvedModel = resolveModelMock.getMockImplementation()!;
      resolveModelMock.mockImplementation((provider, modelId, agentDir, cfg) => {
        const resolved = resolvedModel(provider, modelId, agentDir, cfg);
        return {
          ...resolved,
          model: {
            ...resolved.model,
            contextWindow: modelId === "foreground-model" ? foregroundWindow : summaryWindow,
          },
        };
      });
      resolveContextWindowInfoMock.mockImplementation(
        (input?: { modelContextWindow?: number }) => ({
          tokens: input?.modelContextWindow ?? 128_000,
        }),
      );
      sessionMessages.splice(0, sessionMessages.length, {
        role: "user",
        content: "Independent conversation observations. ".repeat(12_000),
        timestamp: 1,
      });
      const result = await compact({
        ...args(),
        config: { agents: { defaults: { compaction: { model: "openai/summary-model" } } } },
      });
      expect(result).toMatchObject({ ok: true, compacted });
      expect(sessionAutomaticCompactionMock).toHaveBeenCalledTimes(compacted ? 1 : 0);
      expect(createAgentSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          model: expect.objectContaining({ id: "summary-model", contextWindow: summaryWindow }),
        }),
      );
      expect(resolveModelAsyncMock).toHaveBeenCalledWith(
        "openai",
        "foreground-model",
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          deferProviderDynamicModelPreparation: true,
          skipAgentDiscovery: true,
        }),
      );
    },
  );
});
