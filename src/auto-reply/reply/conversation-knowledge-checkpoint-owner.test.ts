import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  prepareConversationKnowledgeCheckpointCoverage,
  type ConversationKnowledgeCheckpoint,
} from "../../config/sessions/conversation-knowledge-checkpoint.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import {
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { registerConversationKnowledgeCheckpointOwner } from "./conversation-knowledge-checkpoint-owner.js";

const boundary = vi.hoisted(() => ({
  owner: undefined as
    | Parameters<
        typeof import("./conversation-knowledge-prefetch-owner.js").createConversationKnowledgePrefetchOwner
      >[0]
    | undefined,
  refs: [] as ConversationKnowledgeReference[],
  read: vi.fn(),
  validate: vi.fn(),
  verifyAll: vi.fn(),
  latest: undefined as ConversationKnowledgeCheckpoint | undefined,
  records: [] as ConversationKnowledgeCheckpoint[],
  coverage: vi.fn(),
  append: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  modelRelease: vi.fn(),
  sourceRelease: vi.fn(),
  plan: vi.fn(),
  summarize: vi.fn(),
  load: vi.fn(),
  warn: vi.fn(),
}));
// mock-isolation: Drive one root quantum deterministically; the native lifecycle is separately exercised by prefetch-owner tests.
vi.mock("./conversation-knowledge-prefetch-owner.js", () => ({
  createConversationKnowledgePrefetchOwner: (params: NonNullable<typeof boundary.owner>) => {
    boundary.owner = params;
    let closed = false;
    return {
      assertCurrent() {
        if (closed) {
          throw new Error("closed");
        }
        params.assertCurrent();
      },
      request() {},
      pausePreparation: () => () => {},
      async close() {
        closed = true;
        // Native revocation clears registry selection before joining cleanup;
        // its second clear must not retire a later root incarnation.
        params.clear();
        await params.settle?.();
        params.clear();
      },
    };
  },
}));
// mock-isolation: Root reference and custody fixtures replace storage, never production histories or provider calls.
vi.mock("../../config/sessions/conversation-knowledge-checkpoint-store.js", () => ({
  readLatestConversationKnowledgeCheckpoint: async (params: { source: SessionSourceAssertion }) => {
    // Preserve the native receipt reader's admission contract at this boundary.
    // A lifetime-only closure must fail before any root projection is published.
    if (!params.source.prepareSessionSource) {
      throw new Error("Composed report sources require worker-prepared authority");
    }
    const prepared = await params.source.prepareSessionSource();
    try {
      if (prepared.nativeSource || prepared.hasOpaqueCheck) {
        throw new Error("Composed report sources require worker-prepared authority");
      }
      prepared.assertCurrent();
      return boundary.latest;
    } finally {
      await prepared.release?.();
    }
  },
  readConversationKnowledgeCheckpointCoverage: boundary.coverage,
  appendConversationKnowledgeCheckpoint: boundary.append,
}));
// mock-isolation: Supply revocable synthetic database custody without opening SQLite or starting admission workers.
vi.mock("../../config/sessions/session-accessor.sqlite-entry-admission.js", () => ({
  loadSessionEntryForAdmission: boundary.load,
}));
// mock-isolation: Drive exact original-reference and cleanup transitions without reading private transcripts or native source workers.
vi.mock("./conversation-knowledge-checkpoint-source.js", () => ({
  prepareConversationKnowledgeCheckpointSources: async (params: {
    retainCleanup(release: () => void): void;
  }) => {
    params.retainCleanup(boundary.sourceRelease);
    return {
      references: boundary.refs,
      read: boundary.read,
      validate: boundary.validate,
      verify: vi.fn(),
      verifyAll: boundary.verifyAll,
      source: () =>
        Object.assign(() => {}, {
          prepareSessionSource: async () => ({ assertCurrent() {}, checks: [] }),
        }),
      release: boundary.sourceRelease,
    };
  },
}));
// mock-isolation: Model leases and synthesis are observed; actual native pressure calculation remains in the owner.
vi.mock("./conversation-knowledge-checkpoint-model.js", () => ({
  acquireConversationKnowledgeCheckpointModel: boundary.acquire,
}));
// mock-isolation: Observe the owner's pressure-to-planning handoff without loading the summarizer/provider graph; summary tests cover native planning.
vi.mock("./conversation-knowledge-checkpoint-summary.js", () => ({
  planConversationKnowledgeCheckpointSummary: boundary.plan,
}));
// mock-isolation: The fixture drives root quanta directly; registering process-wide background lanes would introduce unrelated scheduled work.
vi.mock("../../process/background-work.js", () => ({
  createBackgroundWorkOwner: () => ({ enqueue: vi.fn() }),
}));
// mock-isolation: Count bounded owner warnings without initializing the process logger, terminal state or file log outputs.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: boundary.warn, debug() {} }),
}));

const person = { type: "profile", id: "synthetic-person" } as const;
const branch: ConversationKnowledgeBranch = {
  agentId: "example",
  storePath: "/synthetic/checkpoint-owner.sqlite",
  sessionKey: "agent:example:chat",
  sessionId: "chat-instance",
  lifecycleRevision: "chat-life",
  root: {
    sessionKey: "agent:example:root",
    sessionId: "root-instance",
    lifecycleRevision: "root-life",
  },
};
function reference(index: number): ConversationKnowledgeReference {
  const source = {
    agentId: branch.agentId,
    sessionKey: "agent:example:donor",
    sessionId: "donor-instance",
    lifecycleRevision: "donor-life",
  };
  const through = {
    ...source,
    storePath: branch.storePath,
    generation: "generation",
    rawSeq: index,
    entryId: `message-${index}`,
    activeMessagePosition: index,
    effectiveParentId: null,
  };
  return {
    version: 1,
    sourceMode: "branches",
    source,
    origin: conversationKnowledgeOrigin(source, "utterance-observation"),
    through,
    kind: "utterance-observation",
    role: "user",
    privateAudience: { participant: person, admission: through },
  };
}
const registrations: ReturnType<typeof registerConversationKnowledgeCheckpointOwner>[] = [];
const config: OpenClawConfig = {
  agents: { entries: { example: { conversationMode: "branches" } } },
};
function register(selected = branch, getRuntimeConfig = () => config) {
  let active = true;
  const audience: ConversationPrivateAudience = {
    agentId: selected.agentId,
    sessionKey: selected.sessionKey,
    channelId: "test",
    accountId: "test",
    nativeChannelId: "private-room",
    participant: person,
    assertCurrent() {
      if (!active) {
        throw new Error("expired");
      }
    },
  };
  const ready = vi.fn();
  const registration = registerConversationKnowledgeCheckpointOwner({
    branch: selected,
    participant: person,
    audience,
    env: {},
    getRuntimeConfig,
    onReady: ready,
  });
  registrations.push(registration);
  return {
    registration,
    ready,
    expire() {
      active = false;
    },
  };
}
async function quantum() {
  return boundary.owner!.prepare(new AbortController().signal);
}
beforeEach(() => {
  vi.resetAllMocks();
  boundary.refs = [reference(1)];
  boundary.latest = undefined;
  boundary.records = [];
  boundary.coverage.mockImplementation(
    ({ checkpoint }: { checkpoint: ConversationKnowledgeCheckpoint }) =>
      prepareConversationKnowledgeCheckpointCoverage({
        checkpoint,
        records: boundary.records,
        assertCurrent() {},
      }),
  );
  boundary.append.mockImplementation(
    async ({ checkpoint }: { checkpoint: ConversationKnowledgeCheckpoint }) => {
      boundary.records.push(checkpoint);
      boundary.latest = checkpoint;
    },
  );
  boundary.verifyAll.mockImplementation(async (references, verified) => {
    for (const ref of references) {
      verified(ref, {
        through: ref.readRange?.through ?? ref.through,
        from: ref.readRange?.admission ?? ref.privateAudience?.admission,
      });
    }
    return true;
  });
  boundary.load.mockImplementation(async (target) => ({
    entry: { sessionId: target.sessionId, lifecycleRevision: target.lifecycleRevision },
    databaseClaim: { kind: "worker", reader: {}, assertCurrent() {}, release: boundary.release },
  }));
  boundary.read.mockImplementation(async (ref: ConversationKnowledgeReference) => ({
    contributionId: conversationKnowledgeContributionId(ref),
    complete: true,
    text: "A quoted synthetic observation.",
    reference: ref,
    packet: {
      part: { text: "synthetic packet", complete: true, frontier: ref.through },
      version: {},
      through: ref.readRange?.through ?? ref.through,
      from: ref.readRange?.admission ?? ref.privateAudience?.admission,
    },
  }));
  boundary.validate.mockImplementation(async (ref: ConversationKnowledgeReference) => ({
    through: ref.readRange?.through ?? ref.through,
    from: ref.readRange?.admission ?? ref.privateAudience?.admission,
  }));
  boundary.acquire.mockImplementation(async () => ({
    planning: {
      budget: { contextTokenBudget: 16_000, prompt: "" },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1_000 },
    },
    summarize: boundary.summarize,
    [Symbol.asyncDispose]: boundary.modelRelease,
  }));
});
afterEach(async () => {
  for (const registration of registrations.splice(0)) {
    await registration.close();
  }
});

describe("shared root projection preparation", () => {
  it("prepares later originals past an unavailable range without acknowledging or summarizing the gap", async () => {
    const f = register();
    boundary.refs = [reference(1), reference(2), reference(3)];
    boundary.read.mockResolvedValueOnce(undefined);
    expect(await quantum()).toBe(false);
    expect(boundary.read.mock.calls.map(([ref]) => ref.through.rawSeq)).toEqual([1, 2, 3]);
    expect(f.registration.projection().tail.map((item) => item.reference.through.rawSeq)).toEqual([
      2, 3,
    ]);
    expect(f.ready).toHaveBeenCalledOnce();
    expect(boundary.plan).not.toHaveBeenCalled();
    expect(boundary.summarize).not.toHaveBeenCalled();

    // A later real notification can resolve the gap; prepared later originals
    // remain cached and the original occurrence is never marked consumed.
    expect(await quantum()).toBe(false);
    expect(boundary.read.mock.calls.map(([ref]) => ref.through.rawSeq)).toEqual([1, 2, 3, 1]);
    // A newly opened receiver needs the same root order whether the first
    // original was immediately available or recovered after later originals.
    expect(f.registration.projection().tail.map((item) => item.reference.through.rawSeq)).toEqual([
      1, 2, 3,
    ]);
  });
  it("keeps infrastructure failures eligible for the background owner's retry", async () => {
    register();
    const failure = new Error("Synthetic worker unavailable");
    boundary.read.mockRejectedValueOnce(failure);
    await expect(quantum()).rejects.toBe(failure);
    expect(boundary.summarize).not.toHaveBeenCalled();
    expect(boundary.sourceRelease).toHaveBeenCalledOnce();
    expect(boundary.release).toHaveBeenCalledOnce();
  });
  it("summarizes valid originals across a gap and later adds only the recovered occurrence to coverage", async () => {
    const f = register();
    const missing = reference(1),
      valid = reference(2);
    boundary.refs = [missing, valid];
    const read = boundary.read.getMockImplementation()!;
    boundary.read.mockImplementation(async (ref: ConversationKnowledgeReference) => ({
      ...(await read(ref)),
      text: "quoted ".repeat(2_000),
    }));
    boundary.read.mockResolvedValueOnce(undefined);
    boundary.acquire.mockImplementation(async () => ({
      planning: {
        budget: { contextTokenBudget: 1_000, prompt: "" },
        settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
      },
      summarize: boundary.summarize,
      [Symbol.asyncDispose]: boundary.modelRelease,
    }));
    boundary.plan.mockReturnValue({ kind: "ready" });
    boundary.summarize.mockImplementation(async ({ contributions }) => ({
      kind: "candidate",
      summary: "A summary of the supplied complete originals.",
      coveredContributionIds: contributions.map(
        (item: { contributionId: string }) => item.contributionId,
      ),
      retainedContributionIds: [],
    }));
    expect(await quantum()).toBe(true);
    const first = f.registration.latest()!;
    expect(first.checkpoint.coveredContributionIds).toEqual([
      conversationKnowledgeContributionId(valid),
    ]);
    expect(first.coverage.has(conversationKnowledgeContributionId(missing))).toBe(false);
    expect(boundary.summarize.mock.calls[0]![0].contributions).toHaveLength(1);

    expect(await quantum()).toBe(true);
    const next = f.registration.latest()!;
    expect(next.checkpoint.previousCheckpointId).toBe(first.checkpoint.checkpointId);
    expect(next.checkpoint.coveredContributionIds).toEqual([
      conversationKnowledgeContributionId(missing),
    ]);
    expect([...next.coverage.contributionIds()].toSorted()).toEqual(
      [missing, valid].map(conversationKnowledgeContributionId).toSorted(),
    );
    expect(boundary.read.mock.calls.map(([ref]) => ref.through.rawSeq)).toEqual([1, 2, 1]);
  });
  it("continues preparing valid originals when previous checkpoint coverage leaves source selection", async () => {
    const f = register();
    const read = boundary.read.getMockImplementation()!;
    boundary.read.mockImplementationOnce(async (ref: ConversationKnowledgeReference) => ({
      ...(await read(ref)),
      text: "quoted ".repeat(2_000),
    }));
    boundary.acquire.mockImplementation(async () => ({
      planning: {
        budget: { contextTokenBudget: 1_000, prompt: "" },
        settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
      },
      summarize: boundary.summarize,
      [Symbol.asyncDispose]: boundary.modelRelease,
    }));
    boundary.plan.mockReturnValue({ kind: "ready" });
    boundary.summarize.mockImplementation(async ({ contributions }) => ({
      kind: "candidate",
      summary: "A summary of the original selected source.",
      coveredContributionIds: contributions.map(
        (item: { contributionId: string }) => item.contributionId,
      ),
      retainedContributionIds: [],
    }));
    expect(await quantum()).toBe(true);
    const previous = f.registration.latest()!.checkpoint;
    expect(previous.coveredContributionIds).toEqual([
      conversationKnowledgeContributionId(reference(1)),
    ]);

    // Selection may retire a summarized occurrence after source archival or
    // incarnation replacement. It must neither authorize its old summary nor
    // prevent unrelated, currently verified originals from being prepared.
    boundary.refs = [reference(2)];
    boundary.read.mockImplementationOnce(async (ref: ConversationKnowledgeReference) => ({
      ...(await read(ref)),
      text: "quoted ".repeat(2_000),
    }));
    await quantum();
    await quantum();
    expect(f.registration.latest()).toBeUndefined();
    expect(boundary.latest).toEqual(previous);
    expect(boundary.summarize).toHaveBeenCalledOnce();
    expect(boundary.append).toHaveBeenCalledOnce();
    expect(boundary.plan).toHaveBeenCalledOnce();
    expect(f.registration.projection().tail.map((item) => item.reference.through.rawSeq)).toEqual([
      2,
    ]);

    // Native source recovery restores the original immutable chain. Only the
    // still-uncovered current original is summarized in the successor.
    boundary.refs = [reference(1), reference(2)];
    expect(await quantum()).toBe(true);
    const recovered = f.registration.latest()!;
    expect(recovered.checkpoint.previousCheckpointId).toBe(previous.checkpointId);
    expect(recovered.checkpoint.coveredContributionIds).toEqual([
      conversationKnowledgeContributionId(reference(2)),
    ]);
    expect(boundary.summarize.mock.calls[1]![0].previousSummary).toBe(previous.summary);
    expect(boundary.summarize.mock.calls[1]![0].contributions).toHaveLength(1);
  });
  it("prepares complete originals when native compaction is disabled", async () => {
    const f = register();
    const acquire = boundary.acquire.getMockImplementation()!;
    boundary.acquire.mockImplementation(async () => {
      const model = await acquire();
      return {
        ...model,
        planning: {
          ...model.planning,
          settings: { ...model.planning.settings, enabled: false },
        },
      };
    });
    await quantum();
    expect(f.registration.projection().tail).toHaveLength(1);
    expect(boundary.plan).not.toHaveBeenCalled();
    expect(boundary.summarize).not.toHaveBeenCalled();
    expect(boundary.append).not.toHaveBeenCalled();
  });
  it("hydrates only new originals, shares below-threshold packets and does not reacquire model auth on unchanged roots", async () => {
    const first = register();
    await quantum();
    expect(boundary.read).toHaveBeenCalledOnce();
    expect(boundary.acquire).toHaveBeenCalledOnce();
    expect(first.registration.projection().tail).toHaveLength(1);
    expect(first.ready).toHaveBeenCalledOnce();
    boundary.refs.push(reference(2));
    await quantum();
    expect(boundary.read).toHaveBeenCalledTimes(2);
    expect(boundary.read.mock.calls.map(([ref]) => ref.through.rawSeq)).toEqual([1, 2]);
    expect(first.registration.projection().tail).toHaveLength(2);
    await quantum();
    expect(boundary.read).toHaveBeenCalledTimes(2);
    expect(boundary.acquire).toHaveBeenCalledOnce();
    expect(boundary.plan).not.toHaveBeenCalled();
    expect(boundary.summarize).not.toHaveBeenCalled();
    expect(boundary.modelRelease).toHaveBeenCalledOnce();
  });
  it("invalidates remapped originals and retains another current broker after the first closes", async () => {
    const first = register();
    await quantum();
    const second = register({
      ...branch,
      sessionKey: "agent:example:voice",
      sessionId: "voice-instance",
      lifecycleRevision: "voice-life",
    });
    first.expire();
    await first.registration.close();
    boundary.refs = [
      {
        ...reference(1),
        readRange: { through: reference(2).through, admission: reference(1).through },
      },
    ];
    await quantum();
    expect(boundary.read).toHaveBeenCalledTimes(2);
    expect(second.registration.projection().tail[0]!.packet.through.rawSeq).toBe(2);
    boundary.refs = [];
    await quantum();
    expect(second.registration.projection().tail).toHaveLength(0);
  });
  it("defers unsupported required worker placement without model or storage work and reports once", async () => {
    register(branch, () => ({ ...config, cloudWorkers: { requiredProfile: "dedicated" } }));
    await quantum();
    await quantum();
    expect(boundary.load).not.toHaveBeenCalled();
    expect(boundary.acquire).not.toHaveBeenCalled();
    expect(boundary.warn).toHaveBeenCalledOnce();
  });
  it("retires a reset broker without stranding a second current branch", async () => {
    register();
    const second = register({
      ...branch,
      sessionKey: "agent:example:voice",
      sessionId: "voice-instance",
      lifecycleRevision: "voice-life",
    });
    boundary.load.mockImplementationOnce(async (target) => ({
      entry: { sessionId: target.sessionId, lifecycleRevision: "reset-life" },
      databaseClaim: { kind: "worker", reader: {}, assertCurrent() {}, release: boundary.release },
    }));
    expect(await quantum()).toBe(true);
    expect(boundary.read).not.toHaveBeenCalled();
    await quantum();
    expect(second.registration.projection().tail).toHaveLength(1);
    expect(boundary.load.mock.calls[1]![0].sessionId).toBe("voice-instance");
  });
  it("does not let the reusable byte cache cap suppress native token-pressure summarization", async () => {
    const f = register();
    boundary.acquire.mockImplementation(async () => ({
      planning: {
        budget: { contextTokenBudget: 1_000, prompt: "" },
        settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
      },
      summarize: boundary.summarize,
      [Symbol.asyncDispose]: boundary.modelRelease,
    }));
    boundary.read.mockImplementation(async (ref: ConversationKnowledgeReference) => ({
      contributionId: conversationKnowledgeContributionId(ref),
      complete: true,
      text: "quoted ".repeat(2_000),
      reference: ref,
      packet: {
        part: { text: "x".repeat(5 * 1024 * 1024), complete: true, frontier: ref.through },
        version: {},
        through: ref.through,
        from: ref.privateAudience!.admission,
      },
    }));
    boundary.plan.mockReturnValue({ kind: "ready" });
    boundary.summarize.mockResolvedValue({
      kind: "deferred",
      reason: "synthetic provider unavailable",
    });
    await quantum();
    expect(f.registration.projection().tail).toHaveLength(0);
    expect(boundary.plan).toHaveBeenCalledOnce();
    expect(boundary.summarize).toHaveBeenCalledOnce();
  });
  it("retains failed source cleanup for retry before releasing database custody", async () => {
    register();
    boundary.sourceRelease.mockImplementationOnce(() => {
      throw new Error("synthetic release failure");
    });
    await expect(quantum()).rejects.toThrow("cleanup remains pending");
    expect(boundary.release).not.toHaveBeenCalled();
    await quantum();
    expect(boundary.sourceRelease).toHaveBeenCalledTimes(3);
    expect(boundary.release).toHaveBeenCalledTimes(2);
  });
  it("keeps a replacement root registered while its predecessor finishes deferred cleanup", async () => {
    const first = register();
    const predecessor = boundary.owner;
    const cleanupEntered = createDeferredCore();
    const finishCleanup = createDeferredCore();
    boundary.modelRelease
      .mockRejectedValueOnce(new Error("Synthetic model cleanup needs retry"))
      .mockImplementationOnce(() => {
        cleanupEntered.resolve();
        return finishCleanup.promise;
      });
    await expect(quantum()).rejects.toThrow("cleanup remains pending");
    const closing = first.registration.close();
    try {
      await awaitGateBeforeSettlement(
        cleanupEntered.promise,
        closing,
        "Predecessor cleanup settled before reaching its retained model lease",
      );
      const replacement = register();
      const replacementOwner = boundary.owner;
      expect(replacementOwner).not.toBe(predecessor);
      await quantum();
      expect(replacement.registration.projection().tail).toHaveLength(1);
      finishCleanup.resolve();
      await closing;
      const sibling = register();
      expect(boundary.owner).toBe(replacementOwner);
      expect(sibling.registration.projection().tail).toHaveLength(1);
    } finally {
      finishCleanup.resolve();
      await closing;
    }
  });
  it("retains a model lease cleanup even when acquisition fails before returning a model", async () => {
    register();
    boundary.acquire.mockImplementationOnce(
      async (params: { retainCleanup(release: () => Promise<void>): void }) => {
        params.retainCleanup(boundary.modelRelease);
        throw new Error("synthetic post-acquisition failure");
      },
    );
    boundary.modelRelease.mockRejectedValueOnce(new Error("synthetic model release failure"));
    await expect(quantum()).rejects.toThrow("cleanup remains pending");
    expect(boundary.release).not.toHaveBeenCalled();
    await quantum();
    expect(boundary.modelRelease).toHaveBeenCalledTimes(3);
    expect(boundary.release).toHaveBeenCalledTimes(2);
  });
});
