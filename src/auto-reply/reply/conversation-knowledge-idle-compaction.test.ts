import { beforeEach, expect, it, vi } from "vitest";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "../../agents/embedded-agent-runner/compact.types.js";
import {
  capturePreparedConversationContextBudget,
  createConversationContextCapacity,
} from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import type { EmbeddedAgentCompactResult } from "../../agents/embedded-agent-runner/types.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import type { CustomMessage } from "../../agents/sessions/messages.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  compactConversationKnowledgeWhileIdle,
  runIdleConversationKnowledgeNativeMaintenance,
  type IdleConversationKnowledgeCompactionState,
} from "./conversation-knowledge-idle-compaction.js";

const mocks = vi.hoisted(() => ({
  compact:
    vi.fn<
      (params: CompactEmbeddedAgentSessionRuntimeParams) => Promise<EmbeddedAgentCompactResult>
    >(),
  receipts:
    vi.fn<
      typeof import("../../config/sessions/session-accessor.sqlite-transcript-reports.js").readSessionTranscriptReportReceipts
    >(),
}));
// mock-isolation: Exercise the real idle authority/cleanup adapter without invoking a provider.
vi.mock("../../agents/embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: mocks.compact,
}));
// mock-isolation: Native SQLite scenarios own receipt transaction semantics; this probes exact missing-vs-present decisions.
vi.mock("../../config/sessions/session-accessor.sqlite-transcript-reports.js", () => ({
  readSessionTranscriptReportReceipts: mocks.receipts,
}));

function fixture() {
  const target = {
    agentId: "example",
    sessionId: "recipient",
    sessionKey: "agent:example:branch:recipient",
    storePath: "/virtual/example.sqlite",
    expectedLifecycleRevision: "lifecycle",
  };
  const modelIdentity = { provider: "example-provider", model: "example-model" };
  const placement = {
    ...modelIdentity,
    target,
    workspaceDir: "/virtual/workspace",
    cwd: "/virtual/workspace",
    authProfileId: "selected-profile",
    authProfileIdSource: "user" as const,
    requireWorkspaceOnly: true,
  };
  const value = capturePreparedConversationContextBudget(
    createConversationContextCapacity({
      messages: [],
      contextWindow: 1_000,
      reserveTokens: 100,
      modelIdentity,
      compactionPlacement: placement,
    }),
  );
  if (!value) {
    throw new Error("Missing native issued budget");
  }
  const history: AgentMessage[] = [
    { role: "user", content: "History words. ".repeat(2_000), timestamp: 1 },
  ];
  const version = { generation: "generation", rawSeq: 12, updatedAt: 1 };
  const packet: CustomMessage = {
    role: "custom",
    customType: "conversation-knowledge",
    content: "A small missing observation.",
    details: { packetId: "packet-1" },
    display: false,
    timestamp: 1,
  };
  const state: IdleConversationKnowledgeCompactionState = {};
  const controller = new AbortController();
  const readContext = vi.fn(async () => ({ messages: history, version }));
  const assertCurrent = vi.fn(() => {
    controller.signal.throwIfAborted();
  });
  const params = {
    budget: value,
    config: {},
    target,
    version,
    packet,
    state,
    source: { agentId: target.agentId, path: target.storePath, databaseIdentity: "example-db" },
    consumptionRevision: 0,
    assertCurrent,
    signal: controller.signal,
    readContext,
  };
  mocks.receipts.mockResolvedValue({
    ok: true,
    value: [
      {
        customType: packet.customType,
        receipt: { field: "packetId", value: "packet-1" },
        status: "missing",
      },
    ],
  });
  const issue = (
    input: CompactEmbeddedAgentSessionRuntimeParams,
    fits = false,
    contextWindow = 1_000,
  ) => {
    input.budgetPreflight?.onDecision?.(
      fits,
      createConversationContextCapacity({ messages: history, contextWindow, reserveTokens: 100 }),
    );
  };
  mocks.compact.mockImplementation(async (input) => {
    if (input.budgetPreflight?.checkOnly) {
      issue(input);
      return { ok: true, compacted: false };
    }
    return { ok: true, compacted: true };
  });
  return {
    params,
    controller,
    history,
    version,
    packet,
    state,
    readContext,
    assertCurrent,
    issue,
    placement,
  };
}

beforeEach(() => {
  mocks.compact.mockReset().mockResolvedValue({ ok: true, compacted: true });
  mocks.receipts.mockReset();
});

it("uses selected native placement and exact transcript custody only for one genuinely missing over-budget packet", async () => {
  const f = fixture();
  const after = { ...f.version, rawSeq: 13 };
  f.readContext
    .mockResolvedValueOnce({ messages: f.history, version: f.version })
    .mockResolvedValueOnce({ messages: f.history, version: after });
  mocks.compact.mockImplementationOnce(async (input) => {
    expect(input).toMatchObject({
      authProfileId: "selected-profile",
      authProfileIdSource: "user",
      workspaceDir: "/virtual/workspace",
      requireWorkspaceOnly: true,
      provider: "example-provider",
      model: "example-model",
      sessionTarget: f.params.target,
      disableTools: true,
      modelFallbacksOverride: [],
      trigger: "budget",
    });
    expect(input).not.toHaveProperty("resolvedApiKey");
    expect(input).not.toHaveProperty("runtimePluginToolGrant");
    const source = captureOwnedTranscriptWriteAssertion(f.params.target);
    source();
    const prepared = await source.prepareSessionSource?.();
    expect(prepared?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: expect.objectContaining({
            transcript: { sessionId: "recipient", version: f.version },
          }),
        }),
      ]),
    );
    f.issue(input);
    return { ok: true, compacted: false };
  });
  await expect(compactConversationKnowledgeWhileIdle(f.params)).resolves.toBe(true);
  expect(f.state.blocked).toEqual({ version: after, consumptionRevision: 0 });
  // Replacing packet IDs in the same stalled queue does not authorize more summaries.
  await expect(
    compactConversationKnowledgeWhileIdle({
      ...f.params,
      version: after,
      packet: { ...f.packet, details: { packetId: "packet-2" } },
    }),
  ).resolves.toBe(false);
  expect(mocks.compact).toHaveBeenCalledTimes(3);
});

it.each(["active-model", "historical"] as const)(
  "never compacts a previously committed %s carrier",
  async (status) => {
    const f = fixture();
    mocks.receipts.mockResolvedValue({
      ok: true,
      value: [
        {
          customType: f.packet.customType,
          receipt: { field: "packetId", value: "packet-1" },
          status,
          eventId: "carrier",
          report: { customType: f.packet.customType, content: "fact", display: false },
        },
      ],
    });
    await expect(compactConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(mocks.compact).not.toHaveBeenCalled();
  },
);

it("checks a fresh independent reservation rather than cumulative uncommitted batch pressure", async () => {
  const f = fixture();
  f.readContext.mockResolvedValue({ messages: [], version: f.version });
  await expect(compactConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
  expect(mocks.compact).not.toHaveBeenCalled();
});

it("does not compact for an oversized packet or unproven/cross-session placement", async () => {
  const f = fixture();
  for (const params of [
    { ...f.params, packet: { ...f.packet, content: "word ".repeat(10_000) } },
    { ...f.params, budget: { ...f.params.budget, compactionPlacement: undefined } },
    { ...f.params, target: { ...f.params.target, sessionId: "other" } },
  ]) {
    await expect(compactConversationKnowledgeWhileIdle(params)).resolves.toBe(false);
  }
  expect(mocks.compact).not.toHaveBeenCalled();
  expect(f.readContext).not.toHaveBeenCalled();
});

it("reevaluates a changed window without summarizing a stale pressure proof", async () => {
  const f = fixture();
  f.readContext.mockResolvedValue({ messages: f.history, version: { ...f.version, rawSeq: 14 } });
  await expect(compactConversationKnowledgeWhileIdle(f.params)).resolves.toBe(true);
  expect(mocks.compact).not.toHaveBeenCalled();
});

it("does not repeatedly invoke an unsuccessful native summary for an unchanged full queue", async () => {
  const f = fixture();
  mocks.compact.mockResolvedValue({ ok: false, compacted: false, reason: "summary unavailable" });
  await expect(compactConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
  await expect(
    compactConversationKnowledgeWhileIdle({
      ...f.params,
      packet: { ...f.packet, details: { packetId: "other" } },
    }),
  ).resolves.toBe(false);
  expect(mocks.compact).toHaveBeenCalledOnce();
});

it("does not admit under a smaller maintenance footprint while the real warmed request remains full", async () => {
  const f = fixture();
  const after = { ...f.version, rawSeq: 13 };
  f.readContext
    .mockResolvedValueOnce({ messages: f.history, version: f.version })
    .mockResolvedValue({ messages: f.history, version: after });
  const onReady = vi.fn(async () => true);
  mocks.compact.mockImplementation(async (input) => {
    if (input.budgetPreflight?.checkOnly) {
      f.issue(input, true, 100_000);
      return { ok: true, compacted: false };
    }
    expect(input).toMatchObject({
      forcePreflight: true,
      preflightRequired: true,
      preflightCompactionTrigger: "tokens",
    });
    expect(input.budgetPreflight).toBeUndefined();
    return { ok: true, compacted: true };
  });
  await expect(compactConversationKnowledgeWhileIdle({ ...f.params, onReady })).resolves.toBe(true);
  expect(mocks.compact).toHaveBeenCalledTimes(3);
  expect(onReady).not.toHaveBeenCalled();
});

it("native refusal cannot be overridden by an apparently fitting maintenance capacity", async () => {
  const f = fixture();
  const onReady = vi.fn(async () => true);
  mocks.compact.mockImplementation(async (input) => {
    if (input.budgetPreflight?.checkOnly) {
      f.issue(input, false, 100_000);
    }
    return { ok: true, compacted: false };
  });
  await expect(compactConversationKnowledgeWhileIdle({ ...f.params, onReady })).resolves.toBe(
    false,
  );
  expect(mocks.compact).toHaveBeenCalledTimes(2);
  expect(onReady).not.toHaveBeenCalled();
});

it("prepares one native cold request for a cumulative batch without inference or a guessed foreground budget", async () => {
  const f = fixture();
  const request = { ...f.placement, ...f.params.target, sessionTarget: f.params.target };
  mocks.compact.mockImplementation(async (input) => {
    expect(input.budgetPreflight?.checkOnly).toBe(true);
    f.issue(input, true, 100_000);
    return { ok: true, compacted: false };
  });
  const onReady = vi.fn(async (budget: typeof f.params.budget) => {
    const capacity = budget.capacityForMessages(f.history);
    for (let index = 0; index < 32; index++) {
      expect(capacity({ ...f.packet, details: { packetId: `packet-${index}` } })).toBe(true);
    }
    return true;
  });
  await expect(
    compactConversationKnowledgeWhileIdle({ ...f.params, budget: undefined, request, onReady }),
  ).resolves.toBe(true);
  expect(onReady).toHaveBeenCalledOnce();
  expect(mocks.compact).toHaveBeenCalledOnce();
});

it("checks an oversized cold packet natively once and never summarizes or loops on it", async () => {
  const f = fixture();
  const request = { ...f.placement, ...f.params.target, sessionTarget: f.params.target };
  const params = {
    ...f.params,
    budget: undefined,
    request,
    packet: { ...f.packet, content: "word ".repeat(10_000) },
  };
  await expect(compactConversationKnowledgeWhileIdle(params)).resolves.toBe(false);
  await expect(compactConversationKnowledgeWhileIdle(params)).resolves.toBe(false);
  expect(mocks.compact).toHaveBeenCalledOnce();
  expect(mocks.compact.mock.calls[0]?.[0].budgetPreflight?.checkOnly).toBe(true);
});

it.each(["disabled", "worker"] as const)(
  "does not summarize when native policy is %s",
  async (policy) => {
    const f = fixture();
    const config =
      policy === "disabled"
        ? { agents: { defaults: { compaction: { enabled: false } } } }
        : { cloudWorkers: { requiredProfile: "example-worker" } };
    await expect(compactConversationKnowledgeWhileIdle({ ...f.params, config })).resolves.toBe(
      false,
    );
    expect(mocks.compact.mock.calls.every(([input]) => input.budgetPreflight?.checkOnly)).toBe(
      true,
    );
  },
);

it("retains real cleanup custody after the native logical result", async () => {
  const f = fixture();
  const tail = createDeferredCore();
  const postSummary = createDeferredCore();
  mocks.compact.mockImplementationOnce(async () => {
    void trackAsyncWork(() => tail.promise);
    postSummary.resolve();
    return { ok: true, compacted: true };
  });
  let settled = false;
  const work = runIdleConversationKnowledgeNativeMaintenance({
    ...f.params,
    request: {
      ...f.placement,
      sessionId: f.params.target.sessionId,
      sessionKey: f.params.target.sessionKey,
      workspaceDir: f.placement.workspaceDir,
    },
  }).finally(() => {
    settled = true;
  });
  try {
    await postSummary.promise;
    expect(settled).toBe(false);
  } finally {
    tail.resolve();
  }
  await expect(work).resolves.toMatchObject({ ok: true, compacted: true });
});

it.each(["revoked", "foreground"] as const)(
  "rejects %s ownership before a summary result may cross the boundary",
  async (kind) => {
    const f = fixture();
    mocks.compact.mockImplementationOnce(async () => {
      if (kind === "foreground") {
        f.controller.abort(new Error("foreground acquired"));
      } else {
        f.assertCurrent.mockImplementation(() => {
          throw new Error("principal revoked");
        });
      }
      captureOwnedTranscriptWriteAssertion(f.params.target)();
      return { ok: true, compacted: true };
    });
    await expect(compactConversationKnowledgeWhileIdle(f.params)).rejects.toThrow(
      kind === "foreground" ? "foreground acquired" : "principal revoked",
    );
    if (kind === "foreground") {
      expect(f.state.blocked).toBeUndefined();
    }
  },
);
