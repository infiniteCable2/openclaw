import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeReference } from "../../config/sessions/conversation-knowledge.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import { SessionMutationAuthorizationChangedError } from "../../gateway/session-mutation-authorization-error.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import type { OpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { createConversationKnowledgePrefetchOwner } from "./conversation-knowledge-prefetch-owner.js";
import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import {
  createConversationKnowledgeSourceReader,
  type ConversationKnowledgeHeldSource,
} from "./conversation-knowledge-source-reader.js";

const boundary = vi.hoisted(() => ({
  grant: vi.fn(),
  facts: vi.fn(),
  register: vi.fn<(resource: OpenClawAgentDatabaseAsyncResource) => () => void>(),
}));

// mock-isolation: Supply grant outcomes; native policy classification has its own owner regression.
vi.mock("../../gateway/session-transcript-read-authority.js", () => ({
  prepareTranscriptReadAuthority: boundary.grant,
}));
// mock-isolation: These scenarios stop at grant acquisition, before root or transcript I/O.
vi.mock("../../config/sessions/conversation-knowledge-store.js", () => ({
  issuePreparedKnowledgeRootCandidates: vi.fn(),
  readConversationKnowledgeRoot: vi.fn(),
  readConversationKnowledgeBranch: vi.fn(),
  readPreparedConversationKnowledgeRoot: vi.fn(),
}));
// mock-isolation: Packet identity is fixed here; no packet is hydrated or admitted by this fixture.
vi.mock("../../config/sessions/conversation-knowledge-packets.js", () => ({
  CONVERSATION_KNOWLEDGE_CONTEXT: "openclaw.conversation-knowledge-context.v1",
  conversationKnowledgeContributionId: (receipt: ConversationKnowledgeReference) => receipt.origin,
  createConversationKnowledgePacketReport: vi.fn(),
  readConversationKnowledgePacketProgress: vi.fn(),
}));
// mock-isolation: Observe that denied or failed grants never reach source metadata preparation.
vi.mock("./conversation-knowledge-authority.js", () => ({
  prepareConversationKnowledgeBranchFacts: boundary.facts,
  unavailableConversationKnowledge: vi.fn(),
}));
// mock-isolation: A source grant failure cannot start native transcript payload readers.
vi.mock("../../config/sessions/session-transcript-context-read.js", () => ({
  readSessionTranscriptModelContextAsync: vi.fn(),
  readSessionTranscriptModelContextsAsync: vi.fn(),
}));
// mock-isolation: Cached packet invalidation needs no native receipt operation.
vi.mock("../../config/sessions/session-accessor.sqlite-transcript-reports.js", () => ({
  readSessionTranscriptReportReceipts: vi.fn(),
}));
// mock-isolation: Stage real disposable packets without opening their native validation worker.
vi.mock("../../config/sessions/session-transcript-anchor-read.js", () => ({
  readSessionTranscriptAnchorsAsync: vi.fn(),
}));
// mock-isolation: Retain actual background scheduling while isolating database generation custody.
vi.mock("../../state/openclaw-agent-db-resources.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: boundary.register,
}));
// mock-isolation: No agent database is opened by the scheduler/source-reader composition.
vi.mock("../../state/openclaw-agent-execution.js", () => ({
  captureOpenClawAgentDatabaseExecution: () => ({ assertCurrent() {}, release: async () => {} }),
}));
// mock-isolation: Synthetic failures must not create application logs or disclose source errors.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug() {}, warn() {}, error() {}, info() {} }),
}));
// mock-isolation: Keep real queue scheduling without external diagnostic side effects.
vi.mock("../../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const resources = new Set<OpenClawAgentDatabaseAsyncResource>();

function fixture(signal?: AbortSignal) {
  const branch: ConversationKnowledgeBranch = {
    agentId: "example",
    storePath: path.resolve("synthetic-source-recovery.sqlite"),
    sessionKey: "agent:example:recipient",
    sessionId: "recipient",
    lifecycleRevision: "recipient-life",
    root: { sessionKey: "agent:example:root", sessionId: "root", lifecycleRevision: "root-life" },
  };
  const receipt: ConversationKnowledgeReference = {
    version: 1,
    sourceMode: "branches",
    origin: "source-contribution",
    runId: "source-run",
    source: {
      agentId: branch.agentId,
      sessionKey: "agent:example:source",
      sessionId: "source",
      lifecycleRevision: "source-life",
    },
    through: {
      agentId: branch.agentId,
      sessionKey: "agent:example:source",
      sessionId: "source",
      storePath: branch.storePath,
      generation: "source-generation",
      entryId: "answer",
      rawSeq: 2,
      activeMessagePosition: 1,
      effectiveParentId: "question",
    },
  };
  const assertCurrent = vi.fn();
  const grant = {
    assertCurrent: vi.fn(),
    release: vi.fn(),
    sources: [
      { ...receipt.source, canonicalKey: receipt.source.sessionKey, storePath: branch.storePath },
    ],
  };
  boundary.grant.mockResolvedValue(grant);
  boundary.facts.mockImplementation(() => ({
    assertCurrent() {},
    release() {},
    audience: "private-direct",
    audienceIdentity: "person-example",
  }));
  const cache = createConversationKnowledgeSourceCache();
  cache.stage(receipt.origin, 0, {
    part: {
      origin: receipt.origin,
      text: "An older prepared observation.",
      complete: true,
      nextOffset: undefined,
      frontier: undefined,
    },
    version: { generation: "source-generation", rawSeq: 2, updatedAt: 1 },
    through: receipt.through,
  });
  const reads: ConversationKnowledgeHeldSource[] = [];
  const drop = (read: ConversationKnowledgeHeldSource) => {
    reads.splice(reads.indexOf(read), 1);
    read.facts?.release();
    read.grant.release();
  };
  const reader = createConversationKnowledgeSourceReader({
    branch,
    originalParticipant: { type: "profile", id: "person-example" },
    targetFacts: {
      assertCurrent,
      release() {},
      audience: "private-direct",
      audienceIdentity: "person-example",
    },
    assertCurrent,
    getRuntimeConfig: () => ({
      agents: { entries: { example: { conversationMode: "branches" } } },
    }),
    signal,
    sourceCache: cache,
    hasRetainedContribution: () => false,
    reads,
    drop,
  });
  return { branch, receipt, reader, cache, grant, reads, drop, assertCurrent };
}

beforeEach(() => {
  vi.clearAllMocks();
  boundary.grant.mockReset();
  boundary.facts.mockReset();
  resetCommandQueueStateForTest();
  boundary.register.mockImplementation((resource) => {
    resources.add(resource);
    return () => resources.delete(resource);
  });
});

afterEach(async () => {
  for (const resource of resources) {
    resource.revoke();
    await resource.close();
  }
  expect(resources.size).toBe(0);
  vi.useRealTimers();
  resetCommandQueueStateForTest();
});

describe("source grant failure recovery", () => {
  it.each(["authorization", "range"])(
    "quietly refuses explicit native %s denial without revealing cached data",
    async (kind) => {
      const f = fixture();
      const refusal =
        kind === "authorization"
          ? new SessionMutationAuthorizationChangedError({
              code: "FORBIDDEN",
              message: "Synthetic private source refusal",
            })
          : new SessionTranscriptReadFenceError("Synthetic source range refused");
      boundary.grant.mockRejectedValueOnce(refusal);
      await expect(f.reader.take(f.receipt)).resolves.toEqual({
        source: undefined,
        projection: undefined,
      });
      expect(f.cache.hasContribution(f.receipt.origin)).toBe(false);
      expect(boundary.facts).not.toHaveBeenCalled();
      expect(f.reads).toEqual([]);
    },
  );

  it.each(["worker", "cleanup"])(
    "propagates %s failure rather than settling a missing source",
    async (kind) => {
      const f = fixture();
      const failure =
        kind === "worker"
          ? new Error("Synthetic source worker unavailable")
          : new AggregateError(
              [
                new SessionMutationAuthorizationChangedError({
                  code: "FORBIDDEN",
                  message: "Synthetic refusal",
                }),
                new Error("Synthetic cleanup failure"),
              ],
              "Synthetic cleanup remains pending",
            );
      boundary.grant.mockRejectedValueOnce(failure);
      await expect(f.reader.take(f.receipt)).rejects.toBe(failure);
      expect(f.cache.hasContribution(f.receipt.origin)).toBe(false);
      expect(boundary.facts).not.toHaveBeenCalled();
      expect(f.reads).toEqual([]);
    },
  );

  it("retries a real source-reader failure autonomously through the native background owner", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    boundary.grant.mockRejectedValueOnce(new Error("Synthetic source worker unavailable"));
    let prepared = 0;
    const owner = createConversationKnowledgePrefetchOwner({
      target: f.branch,
      assertCurrent: f.assertCurrent,
      clear: () => f.cache.clear(),
      async prepare() {
        const selected = await f.reader.take(f.receipt);
        if (selected.source) {
          prepared++;
          f.drop(selected.source.read);
        }
      },
    });
    await owner.wait();
    expect(prepared).toBe(0);
    expect(boundary.grant).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await owner.wait();
    expect(prepared).toBe(1);
    expect(boundary.grant).toHaveBeenCalledTimes(2);
    expect(f.grant.release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    await owner.wait();
    expect(boundary.grant).toHaveBeenCalledTimes(2);
    expect(f.reads).toEqual([]);
  });

  it("keeps cancellation authoritative when source acquisition also fails", async () => {
    const controller = new AbortController();
    const f = fixture(controller.signal);
    const cancellation = new Error("Synthetic recipient cancelled");
    boundary.grant.mockImplementationOnce(async () => {
      controller.abort(cancellation);
      throw new SessionMutationAuthorizationChangedError({
        code: "FORBIDDEN",
        message: "Synthetic refusal",
      });
    });
    await expect(f.reader.take(f.receipt)).rejects.toBe(cancellation);
    expect(boundary.facts).not.toHaveBeenCalled();
  });
});
