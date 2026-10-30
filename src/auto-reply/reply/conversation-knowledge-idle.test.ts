import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  capturePreparedConversationContextBudget,
  createConversationContextCapacity,
} from "../../agents/embedded-agent-runner/run/prepared-conversation-context.js";
import { beginForegroundSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SessionEntryCohortResult } from "../../config/sessions/session-entry-read.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { admitPreparedConversationKnowledgeWhileIdle } from "./conversation-knowledge-idle.js";
import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import type { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";

const boundary = vi.hoisted(() => ({
  prepare: vi.fn<typeof prepareReplyConversationKnowledge>(),
}));
// mock-isolation: Admission guards must defer before any source discovery or database write.
vi.mock("./conversation-knowledge.js", () => ({
  prepareReplyConversationKnowledge: boundary.prepare,
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
});

afterEach(async () => {
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

it("retains prepared work while the exact recipient has an active writer", async () => {
  const f = fixture();
  f.stage();
  f.facts.entries[0]!.entry.activeWriterRunId = "active-user-run";
  try {
    await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(f.read).toHaveBeenCalledOnce();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(f.cache.preparedPackets(1)).toHaveLength(1);
  } finally {
    f.cache.clear();
  }
});

it("defers an unknown model budget without provider discovery, writes or compaction", async () => {
  const f = fixture();
  f.stage();
  try {
    await expect(admitPreparedConversationKnowledgeWhileIdle(f.params)).resolves.toBe(false);
    expect(f.read).toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(f.cache.preparedPackets(1)).toHaveLength(1);
  } finally {
    f.cache.clear();
  }
});

it("defers a provider-owned runtime even without a session runtime override", async () => {
  const f = fixture();
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
  } finally {
    f.cache.clear();
  }
});
