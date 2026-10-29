import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import { readSessionTranscriptReportReceipts } from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SessionTranscriptModelContext } from "../../config/sessions/session-history-read.types.js";
import {
  readSessionTranscriptModelContextAsync,
  readSessionTranscriptModelContextsAsync,
} from "../../config/sessions/session-transcript-context-read.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import { SessionMutationAuthorizationChangedError } from "../../gateway/session-mutation-authorization-error.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import type { OpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { createConversationKnowledgePrefetchOwner } from "./conversation-knowledge-prefetch-owner.js";
import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import {
  createConversationKnowledgeSourceReader,
  readConversationKnowledgeInputs,
  stageConversationKnowledgeSource,
  type ConversationKnowledgeHeldSource,
} from "./conversation-knowledge-source-reader.js";

const boundary = vi.hoisted(() => ({
  grant: vi.fn(),
  facts: vi.fn(),
  root: vi.fn(),
  rebind: vi.fn(),
  manifest: vi.fn(),
  progress: vi.fn(),
  version: vi.fn(),
  register: vi.fn<(resource: OpenClawAgentDatabaseAsyncResource) => () => void>(),
}));

// mock-isolation: Supply grant outcomes; native policy classification has its own owner regression.
vi.mock("../../gateway/session-transcript-read-authority.js", () => ({
  prepareTranscriptReadAuthority: boundary.grant,
}));
// mock-isolation: Native facts and provenance are supplied without opening their databases.
vi.mock("../../config/sessions/conversation-knowledge-store.js", () => ({
  issuePreparedKnowledgeRootCandidates: boundary.manifest,
  readConversationKnowledgeRoot: boundary.root,
  readConversationKnowledgeBranch: vi.fn(),
  readPreparedConversationKnowledgeRoot: boundary.rebind,
}));
// mock-isolation: Packet identity is fixed here; no packet is hydrated or admitted by this fixture.
vi.mock("../../config/sessions/conversation-knowledge-packets.js", () => ({
  CONVERSATION_KNOWLEDGE_CONTEXT: "openclaw.conversation-knowledge-context.v1",
  conversationKnowledgeContributionId: (receipt: ConversationKnowledgeReference) => receipt.origin,
  createConversationKnowledgePacketReport: vi.fn(),
  readConversationKnowledgePacketProgress: boundary.progress,
}));
// mock-isolation: Exercise full native version decisions without running hydration workers.
vi.mock("../../config/sessions/session-transcript-hydration.js", () => ({
  prepareSessionTranscriptHydration: (target: { sessionId: string }) => ({
    readMaintenance: () => boundary.version(target),
  }),
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
    audience: "private-direct" as const,
    audienceIdentity: "person-example",
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

describe("versioned background input snapshots", () => {
  function inputs(maxBytes = 4 * 1024 * 1024) {
    const { branch, receipt } = fixture();
    const cache = createConversationKnowledgeSourceCache(maxBytes);
    const versions = {
      root: { generation: "root-generation", rawSeq: 3, updatedAt: 10 },
      recipient: { generation: "recipient-generation", rawSeq: 8, updatedAt: 20 },
    };
    const events = Object.assign(
      [
        {
          type: "custom_message",
          customType: CONVERSATION_KNOWLEDGE_REPORT,
          details: { ...receipt, origin: conversationKnowledgeOrigin(receipt.source) },
        },
      ],
      { evidence: {} },
    );
    const manifests = new WeakMap<object, typeof events>();
    boundary.root.mockResolvedValue(events);
    const progress = new Map([["existing", { complete: true, nextOffset: 12 }]]);
    boundary.progress.mockResolvedValue(progress);
    boundary.version.mockImplementation(async (target: { sessionId: "root" | "recipient" }) => ({
      kind: "transcript-maintenance",
      version: structuredClone(versions[target.sessionId]),
    }));
    boundary.manifest.mockImplementation(
      (_evidence, references: readonly unknown[], options: { maxBytes: number }) => {
        const manifest = { byteLength: references.length ? 600 : 80 };
        if (manifest.byteLength > options.maxBytes) {
          throw new RangeError("Synthetic native manifest exceeds budget");
        }
        manifests.set(manifest, references.length ? events : Object.assign([], { evidence: {} }));
        return manifest;
      },
    );
    boundary.rebind.mockImplementation(async ({ manifest }: { manifest: object }) => {
      const saved = manifests.get(manifest);
      if (!saved) {
        throw new Error("Synthetic provenance is not from this native owner");
      }
      return saved;
    });
    const reader: SessionEntryCohortReader = {
      database: { agentId: branch.agentId, path: branch.storePath, env: {} },
      sessionKey: branch.sessionKey,
      logicalAgentId: branch.agentId,
      storePaths: [branch.storePath],
      assertCurrent() {},
      async withRead() {
        throw new Error("Only the mocked native snapshot boundaries may read this fixture");
      },
    };
    const read = () =>
      readConversationKnowledgeInputs({
        branch,
        reader,
        assertCurrent() {},
        preparationOnly: true,
        retainInHistory: false,
        sourceCache: cache,
      });
    return { read, cache, versions, events, branch, receipt, progress };
  }

  it("reuses unchanged snapshots only after fresh native physical rebind", async () => {
    const f = inputs();
    await f.read();
    f.progress.clear();
    const second = await f.read();
    expect(second?.events).toEqual(f.events);
    expect(second?.retained?.get("existing")).toEqual({ complete: true, nextOffset: 12 });
    expect(boundary.root).toHaveBeenCalledOnce();
    expect(boundary.progress).toHaveBeenCalledOnce();
    expect(boundary.rebind).toHaveBeenCalledTimes(2);
    expect(boundary.version).toHaveBeenCalledTimes(8);
  });

  it("invalidates root and progress independently, including same-sequence navigation edits", async () => {
    const f = inputs();
    await f.read();
    f.versions.root.updatedAt++;
    await f.read();
    expect(boundary.root).toHaveBeenCalledTimes(2);
    expect(boundary.progress).toHaveBeenCalledOnce();
    f.versions.recipient.updatedAt++;
    await f.read();
    expect(boundary.root).toHaveBeenCalledTimes(2);
    expect(boundary.progress).toHaveBeenCalledTimes(2);
    f.cache.consume("not-staged", 0);
    await f.read();
    expect(boundary.root).toHaveBeenCalledTimes(2);
    expect(boundary.progress).toHaveBeenCalledTimes(3);
  });

  it.each(["consume", "clear"])("does not publish an awaited snapshot after %s", async (kind) => {
    const f = inputs();
    boundary.root.mockImplementationOnce(async () => {
      if (kind === "consume") {
        f.cache.consume("not-staged", 0);
      } else {
        f.cache.clear();
      }
      return f.events;
    });
    await f.read();
    expect(f.cache.preparationRoot(f.versions.root)).toBeUndefined();
    expect(f.cache.preparationProgress(f.versions.recipient)).toBeUndefined();
    await f.read();
    expect(boundary.root).toHaveBeenCalledTimes(2);
    expect(boundary.progress).toHaveBeenCalledTimes(2);
  });

  it("does not retain a root snapshot changed during its load", async () => {
    const f = inputs();
    boundary.root.mockImplementationOnce(async () => {
      f.versions.root.updatedAt++;
      return f.events;
    });
    await f.read();
    expect(f.cache.preparationRoot(f.versions.root)).toBeUndefined();
    await f.read();
    expect(boundary.root).toHaveBeenCalledTimes(2);
    expect(boundary.progress).toHaveBeenCalledOnce();
  });

  it("refuses cached data when native physical or lifecycle rebind fails", async () => {
    const f = inputs();
    await f.read();
    boundary.rebind.mockRejectedValueOnce(new Error("Synthetic native source replaced"));
    await expect(f.read()).rejects.toThrow("Synthetic native source replaced");
    expect(f.cache.preparationRoot(f.versions.root)).toBeUndefined();
    expect(f.cache.preparationProgress(f.versions.recipient)).toBeUndefined();
    await f.read();
    expect(boundary.root).toHaveBeenCalledTimes(2);
    expect(boundary.progress).toHaveBeenCalledTimes(2);
  });

  it("keeps oversized inputs readable without retaining a partial snapshot", async () => {
    const f = inputs(1);
    expect((await f.read())?.events).toEqual(f.events);
    expect((await f.read())?.retained?.has("existing")).toBe(true);
    expect(boundary.root).toHaveBeenCalledTimes(2);
    expect(boundary.progress).toHaveBeenCalledTimes(2);
  });

  it("shares the raw budget with foreground provenance while protecting staged packets", async () => {
    const f = inputs(1024);
    await f.read();
    const manifest = f.cache.preparationRoot(f.versions.root)!;
    expect(f.cache.preparationProgress(f.versions.recipient)).toBeDefined();
    const packet = {
      part: {
        origin: "pending",
        text: "pending",
        complete: true,
        nextOffset: undefined,
        frontier: undefined,
      },
      version: f.versions.recipient,
      through: f.receipt.through,
    };
    expect(f.cache.stage("pending", 0, packet)).toBe(true);
    f.cache.setPreparedRoot(manifest);
    expect(f.cache.preparationRoot(f.versions.root)).toBeUndefined();
    expect(f.cache.preparationProgress(f.versions.recipient)).toBeUndefined();
    expect(f.cache.peek("pending", 0)).toEqual(packet);
  });
});

describe("bounded authorized source preparation", () => {
  function longSource() {
    const { receipt } = fixture();
    const question = "Keep this complete synthetic observation.";
    const answer = "A long synthetic observation with a plant 🌿. ".repeat(4_000);
    const projection: SessionTranscriptModelContext = {
      version: { generation: receipt.through.generation, rawSeq: 2, updatedAt: 1 },
      events: [
        {
          type: "message",
          id: "question",
          message: { role: "user", content: question, timestamp: 1 },
        },
        {
          type: "message",
          id: "answer",
          message: {
            role: "assistant",
            content: [{ type: "text", text: answer }],
            stopReason: "stop",
            timestamp: 2,
            __openclaw: { runId: receipt.runId },
          },
        },
      ],
    };
    return { receipt, projection, text: question + answer };
  }

  it("fills beyond two segments, stops at its byte budget, and preserves the exact source prefix", async () => {
    const source = longSource();
    const maxBytes = 32 * 1024;
    const cache = createConversationKnowledgeSourceCache(maxBytes);
    const request = {
      ...source,
      audience: "private-direct" as const,
      offset: 0,
      through: source.receipt.through,
      assertCurrent() {},
      cache,
      expectedConsumptionRevision: cache.consumptionRevision,
    };
    expect(await stageConversationKnowledgeSource(request)).toBe("cache-full");
    const slots = cache.preparedPackets(100);
    expect(slots.length).toBeGreaterThan(2);
    expect(slots.length).toBeLessThan(100);
    let offset = 0;
    let text = "";
    let bytes = 0;
    const prepared = slots.map((slot) => {
      expect(slot).toEqual({ contributionId: source.receipt.origin, offset });
      const packet = cache.peek(slot.contributionId, slot.offset)!;
      expect(packet.through).toEqual(source.receipt.through);
      expect(packet.version).toEqual(source.projection.version);
      expect(packet.part.complete).toBe(false);
      const content = asOptionalRecord(JSON.parse(packet.part.text));
      expect(content?.contentOffset).toBe(offset);
      expect(Array.isArray(content?.observations)).toBe(true);
      for (const observation of content!.observations as unknown[]) {
        const row = asOptionalRecord(observation);
        expect(typeof row?.text).toBe("string");
        if (typeof row?.text === "string") {
          text += row.text;
        }
      }
      expect(packet.part.nextOffset).toBeGreaterThan(offset);
      offset = packet.part.nextOffset!;
      expect(text).toBe(source.text.slice(0, offset));
      bytes += Buffer.byteLength(JSON.stringify(packet));
      return packet;
    });
    expect(bytes).toBeLessThanOrEqual(maxBytes);
    expect(cache.peek(source.receipt.origin, offset)).toBeUndefined();
    expect(await stageConversationKnowledgeSource(request)).toBe("cache-full");
    expect(slots.map((slot) => cache.peek(slot.contributionId, slot.offset))).toEqual(prepared);
    expect(boundary.grant).not.toHaveBeenCalled();
    expect(readSessionTranscriptModelContextAsync).not.toHaveBeenCalled();
    expect(readSessionTranscriptModelContextsAsync).not.toHaveBeenCalled();
    expect(readSessionTranscriptReportReceipts).not.toHaveBeenCalled();
  });

  it("does not stage stale progress after a packet is consumed before preparation", async () => {
    const source = longSource();
    const cache = createConversationKnowledgeSourceCache(32 * 1024);
    const expectedConsumptionRevision = cache.consumptionRevision;
    // The native recipient can admit this packet before the preparer has staged it.
    cache.consume(source.receipt.origin, 0);
    const stage = vi.spyOn(cache, "stage");
    const result = await stageConversationKnowledgeSource({
      ...source,
      audience: "private-direct",
      offset: 0,
      through: source.receipt.through,
      assertCurrent() {},
      cache,
      expectedConsumptionRevision,
    });
    expect(stage).not.toHaveBeenCalled();
    expect(cache.preparedPackets(100)).toEqual([]);
    expect(result).toBe("recipient-advanced");
    expect(readSessionTranscriptReportReceipts).not.toHaveBeenCalled();
  });

  it("stops the old preparer at its cooperative yield after foreground consumption", async () => {
    const source = longSource();
    const cache = createConversationKnowledgeSourceCache(32 * 1024);
    const request = {
      ...source,
      audience: "private-direct" as const,
      offset: 0,
      through: source.receipt.through,
      assertCurrent() {},
      cache,
      expectedConsumptionRevision: cache.consumptionRevision,
    };
    await stageConversationKnowledgeSource(request);
    const initial = cache.preparedPackets(100);
    expect(initial.length).toBeGreaterThan(2);
    const acceptedPrefix = initial.slice(0, 2);
    const pending = initial.slice(2);
    const pendingPackets = pending.map((slot) => cache.peek(slot.contributionId, slot.offset));
    const originalStage = cache.stage.bind(cache);
    const stage = vi.spyOn(cache, "stage").mockImplementationOnce((...args) => {
      const staged = originalStage(...args);
      // The foreground native batch accepted two already-prepared packets while
      // the old producer still holds the progress snapshot preceding that batch.
      queueMicrotask(() => {
        for (const slot of acceptedPrefix) {
          cache.consume(slot.contributionId, slot.offset);
        }
      });
      return staged;
    });
    const result = await stageConversationKnowledgeSource(request);
    for (const slot of acceptedPrefix) {
      expect(cache.peek(slot.contributionId, slot.offset)).toBeUndefined();
    }
    expect(cache.preparedPackets(100)).toEqual(pending);
    expect(pending.map((slot) => cache.peek(slot.contributionId, slot.offset))).toEqual(
      pendingPackets,
    );
    expect(stage).toHaveBeenCalledOnce();
    expect(result).toBe("recipient-advanced");
    // Reusing the stale captured progress cannot resurrect the accepted prefix.
    expect(await stageConversationKnowledgeSource(request)).toBe("recipient-advanced");
    expect(stage).toHaveBeenCalledOnce();
    // Only a new quantum with freshly read native progress may prepare its suffix.
    expect(
      await stageConversationKnowledgeSource({
        ...request,
        offset: pending[0]!.offset,
        expectedConsumptionRevision: cache.consumptionRevision,
      }),
    ).toBe("cache-full");
    for (const slot of acceptedPrefix) {
      expect(cache.peek(slot.contributionId, slot.offset)).toBeUndefined();
    }
    expect(cache.firstPreparedOffset(source.receipt.origin)).toBe(pending[0]!.offset);
    expect(pending.map((slot) => cache.peek(slot.contributionId, slot.offset))).toEqual(
      pendingPackets,
    );
    expect(boundary.grant).not.toHaveBeenCalled();
    expect(readSessionTranscriptReportReceipts).not.toHaveBeenCalled();
  });

  it("honors cancellation at the first cooperative segment yield", async () => {
    const source = longSource();
    const cache = createConversationKnowledgeSourceCache(32 * 1024);
    const controller = new AbortController();
    const cancellation = new Error("Synthetic preparation cancelled");
    const originalStage = cache.stage.bind(cache);
    const stage = vi.spyOn(cache, "stage").mockImplementation((...args) => {
      const staged = originalStage(...args);
      queueMicrotask(() => controller.abort(cancellation));
      return staged;
    });
    await expect(
      stageConversationKnowledgeSource({
        ...source,
        audience: "private-direct",
        offset: 0,
        through: source.receipt.through,
        assertCurrent: () => controller.signal.throwIfAborted(),
        signal: controller.signal,
        cache,
        expectedConsumptionRevision: cache.consumptionRevision,
      }),
    ).rejects.toMatchObject({ name: "AbortError", cause: cancellation });
    expect(stage).toHaveBeenCalledOnce();
    expect(cache.preparedPackets(100)).toEqual([
      { contributionId: source.receipt.origin, offset: 0 },
    ]);
    expect(boundary.grant).not.toHaveBeenCalled();
    expect(readSessionTranscriptReportReceipts).not.toHaveBeenCalled();
  });
});
