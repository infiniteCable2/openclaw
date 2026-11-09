import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  capturePreparedConversationContextBudget,
  createConversationContextCapacity,
} from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import { beginForegroundSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SessionEntryCohortResult } from "../../config/sessions/session-entry-read.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as runRegistry from "../../infra/agent-run-registry.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { admitPreparedConversationKnowledgeWhileIdle } from "./conversation-knowledge-idle.js";
import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import * as knowledgeStatus from "./conversation-knowledge-status.js";
import type { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";

const boundary = vi.hoisted(() => ({
  prepare: vi.fn<typeof prepareReplyConversationKnowledge>(),
  context: vi.fn(),
  busy: vi.fn(() => false),
}));
// The Gateway scenarios cover real settled/queued runtime and worker admission.
// mock-isolation: Probe native ownership decisions without creating model backends.
vi.mock("../../sessions/session-controller.lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-controller.lifecycle.js")>()),
  isCompetingSessionControllerWorkActive: boundary.busy,
}));
// mock-isolation: Admission guards must defer before any source discovery or database write.
vi.mock("./conversation-knowledge.js", () => ({
  prepareReplyConversationKnowledge: boundary.prepare,
}));
// mock-isolation: The positive orchestration case supplies a canonical snapshot;
// actual physical context fencing and durable writes run in the native SQLite scenario.
vi.mock("../../config/sessions/session-transcript-context-read.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../config/sessions/session-transcript-context-read.js")
  >()),
  readSessionTranscriptContextProjectionAsync: boundary.context,
}));

const branch = {
  agentId: "example",
  sessionKey: "agent:example:branch:idle",
  sessionId: "idle-session",
  storePath: "/virtual/idle/example.sqlite",
  lifecycleRevision: "idle-lifecycle",
  root: {
    sessionKey: "agent:example:root",
    sessionId: "root-session",
    lifecycleRevision: "root-lifecycle",
  },
};

function fixture() {
  const cache = createConversationKnowledgeSourceCache();
  const facts: SessionEntryCohortResult = {
    kind: "session-exact-entries",
    entries: [
      {
        sessionKey: branch.sessionKey,
        entry: {
          sessionId: branch.sessionId,
          updatedAt: 1,
          lifecycleRevision: branch.lifecycleRevision,
        },
      },
    ],
    source: { agentId: branch.agentId, path: branch.storePath, databaseIdentity: "synthetic-db" },
    databaseIdentity: {
      identity: "synthetic-db",
      incarnation: "synthetic-incarnation",
      filename: branch.storePath,
    },
    lifecycleTimestamps: {},
  };
  const read = vi.fn();
  const reader: SessionEntryCohortReader = {
    database: { agentId: branch.agentId, path: branch.storePath, env: {} },
    sessionKey: branch.sessionKey,
    logicalAgentId: branch.agentId,
    storePaths: [branch.storePath],
    assertCurrent: () => {},
    async readEntry(assertCurrent) {
      assertCurrent();
      const entry = facts.entries.find((row) => row.sessionKey === branch.sessionKey)?.entry;
      if (!entry) {
        throw new Error("Synthetic recipient entry is unavailable");
      }
      return { entry, source: facts.source };
    },
    async withRead(request, assertCurrent, consume) {
      read(request);
      assertCurrent();
      return consume(facts, assertCurrent);
    },
  };
  const stage = () =>
    cache.stage("synthetic-contribution", 0, {
      part: {
        origin: "synthetic-source",
        text: "Prepared fact.",
        complete: true,
        nextOffset: undefined,
        frontier: undefined,
      },
      version: { generation: "source-generation", rawSeq: 1, updatedAt: 1 },
      through: {
        ...branch,
        generation: "source-generation",
        entryId: "source-message",
        rawSeq: 1,
        effectiveParentId: null,
        activeMessagePosition: 1,
      },
    });
  const config: OpenClawConfig = {
    agents: { defaults: { model: "synthetic-idle-provider/unknown-model" } },
  };
  const params: Parameters<typeof admitPreparedConversationKnowledgeWhileIdle>[0] = {
    branch,
    reader,
    sourceCache: cache,
    assertCurrent: () => {},
    getRuntimeConfig: () => config,
  };
  const budget = capturePreparedConversationContextBudget(
    createConversationContextCapacity({
      messages: [],
      contextWindow: 100_000,
      reserveTokens: 10_000,
    }),
  );
  if (!budget) {
    throw new Error("Expected native issued context budget");
  }
  params.budget = {
    value: budget,
    provider: "synthetic-idle-provider",
    model: "unknown-model",
    config,
  };
  return { cache, facts, read, stage, params };
}

beforeEach(() => {
  boundary.prepare.mockReset();
  boundary.context.mockReset();
  boundary.busy.mockReset().mockReturnValue(false);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await drainGlobalSingletonLifecycleState("close");
});

it("does no model-context or writer work when no packets are prepared", async () => {
  const f = fixture();
  try {
    await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(f.read).not.toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
  } finally {
    f.cache.clear();
  }
});

it("prepares only when no native request has issued a reusable budget", async () => {
  const f = fixture();
  f.stage();
  f.params.budget = undefined;
  try {
    await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(f.read).not.toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(f.cache.preparedPackets(1)).toHaveLength(1);
  } finally {
    f.cache.clear();
  }
});

it.each([
  "consume",
  "invalidate",
  "unchanged",
  "execution-started-during-read",
  "capacity",
] as const)(
  "does not forward preparation-only mode and continues only after changed work (%s)",
  async (outcome) => {
    const f = fixture();
    const diagnostics = vi
      .spyOn(knowledgeStatus, "logConversationKnowledgeIdleDeferral")
      .mockImplementation(() => {});
    f.stage();
    f.facts.entries[0]!.entry.activeWriterRunId = "settled-user-run";
    f.facts.entries[0]!.entry.status = "done";
    const config = f.params.getRuntimeConfig();
    config.models = {
      providers: {
        "synthetic-idle-provider": {
          baseUrl: "https://provider.example.test/v1",
          api: "openai-completions",
          models: [
            {
              id: "unknown-model",
              name: "Synthetic idle budget",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 100_000,
              maxTokens: 10_000,
            },
          ],
        },
      },
    };
    const version = { generation: "recipient-generation", rawSeq: 1, updatedAt: 1 };
    boundary.context.mockImplementation(async () => {
      if (outcome === "execution-started-during-read") {
        boundary.busy.mockReturnValue(true);
      }
      return { messages: [], version };
    });
    boundary.prepare.mockImplementation(async (input) => {
      input.assertCurrent();
      if (outcome === "capacity") {
        const packet = {
          role: "custom" as const,
          customType: "synthetic-idle-capacity",
          content: "Small prepared fact.",
          display: false,
          timestamp: 1,
        };
        expect(input.canAdmitPacket?.(packet)).toBe(true);
        expect(input.canAdmitPacket?.({ ...packet, content: "word ".repeat(120_000) })).toBe(false);
      }
      if (!input.preparationOnly) {
        if (outcome === "consume") {
          f.cache.consume("synthetic-contribution", 0);
        } else if (outcome === "invalidate") {
          f.cache.invalidateContribution("synthetic-contribution");
        }
      }
      return undefined;
    });
    // Structural parameter types do not remove additional properties at runtime.
    const preparation = { ...f.params, preparationOnly: true };
    try {
      await expect(admitPreparedConversationKnowledgeWhileIdle(preparation)).resolves.toBe(
        outcome === "consume" || outcome === "invalidate",
      );
      expect(f.facts.entries[0]!.entry.activeWriterRunId).toBe("settled-user-run");
      if (outcome === "execution-started-during-read") {
        expect(boundary.prepare).not.toHaveBeenCalled();
        expect(f.cache.preparedPackets(1)).toHaveLength(1);
        return;
      }
      expect(boundary.prepare).toHaveBeenCalledOnce();
      expect(boundary.prepare.mock.calls[0]![0]).not.toHaveProperty("preparationOnly");
      expect(boundary.prepare.mock.calls[0]![0]).toMatchObject({
        readyOnly: true,
        retainInHistory: { expectedTranscriptVersion: version },
      });
      expect(f.cache.consumptionRevision).toBe(outcome === "consume" ? 1 : 0);
      expect(f.cache.preparedPackets(1)).toHaveLength(
        outcome === "unchanged" || outcome === "capacity" ? 1 : 0,
      );
      if (outcome === "capacity") {
        expect(diagnostics).toHaveBeenCalledExactlyOnceWith({
          recipient: branch.sessionId,
          reason: "capacity",
          preparedPackets: 1,
          checkpoint: false,
          consumptionChanges: 0,
          capacityChecks: 2,
          capacityRefusals: 1,
        });
      }
      if (outcome !== "unchanged" && outcome !== "capacity") {
        boundary.prepare.mockClear();
        await expect(admitPreparedConversationKnowledgeWhileIdle(preparation)).resolves.toBe(false);
        expect(boundary.prepare).not.toHaveBeenCalled();
      }
    } finally {
      f.cache.clear();
    }
  },
);

it.each(["missing-budget", "config-version", "no-prepared", "busy", "model"] as const)(
  "reports the native idle deferral reason without dispatching work: %s",
  async (reason) => {
    const f = fixture();
    const diagnostics = vi
      .spyOn(knowledgeStatus, "logConversationKnowledgeIdleDeferral")
      .mockImplementation(() => {});
    if (reason !== "no-prepared") {
      f.stage();
    }
    if (reason === "missing-budget") {
      f.params.budget = undefined;
    } else if (reason === "config-version") {
      const changed = structuredClone(f.params.getRuntimeConfig());
      f.params.getRuntimeConfig = () => changed;
    } else if (reason === "busy") {
      boundary.busy.mockReturnValue(true);
    } else if (reason === "model") {
      if (!f.params.budget) {
        throw new Error("Expected native issued idle budget");
      }
      f.params.budget = { ...f.params.budget, model: "other-model" };
    }
    try {
      await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
      expect(diagnostics).toHaveBeenCalledExactlyOnceWith({
        recipient: branch.sessionId,
        reason,
        preparedPackets: reason === "no-prepared" ? 0 : 1,
        checkpoint: false,
        ...(reason === "model"
          ? { consumptionChanges: 0, capacityChecks: 0, capacityRefusals: 0 }
          : {}),
      });
      expect(boundary.prepare).not.toHaveBeenCalled();
    } finally {
      f.cache.clear();
    }
  },
);

it("does not reuse a prompt footprint across a published configuration change", async () => {
  const f = fixture();
  f.stage();
  const replacement = structuredClone(f.params.getRuntimeConfig());
  f.params.getRuntimeConfig = () => replacement;
  try {
    await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(f.read).not.toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(f.cache.preparedPackets(1)).toHaveLength(1);
  } finally {
    f.cache.clear();
  }
});

it("returns without waiting for a foreground reservation", async () => {
  const f = fixture();
  f.stage();
  const release = await beginForegroundSessionMaintenance(branch.sessionKey);
  try {
    await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(f.read).not.toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(f.cache.preparedPackets(1)).toHaveLength(1);
  } finally {
    release();
    f.cache.clear();
  }
});

it("retains prepared work while the saved writer still has an execution owner", async () => {
  const f = fixture();
  f.stage();
  f.facts.entries[0]!.entry.activeWriterRunId = "active-user-run";
  vi.spyOn(runRegistry, "hasAgentRunContextExecutionOwner").mockReturnValue(true);
  try {
    await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(f.read).toHaveBeenCalledOnce();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(f.cache.preparedPackets(1)).toHaveLength(1);
  } finally {
    f.cache.clear();
  }
});

it("returns before a recipient read while native session work still owns the target", async () => {
  const f = fixture();
  f.stage();
  boundary.busy.mockReturnValue(true);
  try {
    await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(f.read).not.toHaveBeenCalled();
    expect(boundary.context).not.toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(f.cache.preparedPackets(1)).toHaveLength(1);
  } finally {
    f.cache.clear();
  }
});

it("defers pending delivery independently of a settled writer fence", async () => {
  const f = fixture();
  f.stage();
  Object.assign(f.facts.entries[0]!.entry, {
    activeWriterRunId: "settled-writer",
    status: "done",
    pendingFinalDelivery: {
      kind: "transport-only",
      intentId: "pending-fixture-delivery",
      deliveries: [],
      createdAt: 1,
    },
  });
  try {
    await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(f.read).toHaveBeenCalledOnce();
    expect(boundary.context).not.toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(f.cache.preparedPackets(1)).toHaveLength(1);
  } finally {
    f.cache.clear();
  }
});

it("defers an unknown model budget without provider discovery, writes or compaction", async () => {
  const f = fixture();
  const diagnostics = vi
    .spyOn(knowledgeStatus, "logConversationKnowledgeIdleDeferral")
    .mockImplementation(() => {});
  f.stage();
  try {
    await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(f.read).toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(f.cache.preparedPackets(1)).toHaveLength(1);
    expect(diagnostics).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "context-window" }),
    );
  } finally {
    f.cache.clear();
  }
});

it("defers a provider-owned runtime even without a session runtime override", async () => {
  const f = fixture();
  const diagnostics = vi
    .spyOn(knowledgeStatus, "logConversationKnowledgeIdleDeferral")
    .mockImplementation(() => {});
  f.stage();
  const config: OpenClawConfig = {
    agents: { defaults: { model: "synthetic-idle-provider/unknown-model" } },
    models: {
      providers: {
        "synthetic-idle-provider": {
          baseUrl: "https://provider.example.test/v1",
          models: [],
          agentRuntime: { id: "codex" },
        },
      },
    },
  };
  f.params.getRuntimeConfig = () => config;
  if (!f.params.budget) {
    throw new Error("Expected issued budget");
  }
  f.params.budget = { ...f.params.budget, config };
  try {
    await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(f.read).toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(f.cache.preparedPackets(1)).toHaveLength(1);
    expect(diagnostics).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "harness" }),
    );
  } finally {
    f.cache.clear();
  }
});
