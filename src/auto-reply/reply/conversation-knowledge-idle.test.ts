import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGlobalLane } from "../../agents/embedded-agent-runner/lanes.js";
import { beginForegroundSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import { withOwnedSessionTranscriptWriterFence } from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { captureAsyncWorkTracker, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import { runIdleConversationKnowledge } from "./conversation-knowledge-idle.js";

const boundary = vi.hoisted(() => ({
  load: vi.fn(),
  admission: vi.fn(),
  prepare: vi.fn(),
  maintenance: vi.fn(),
}));

// mock-isolation: Exercise idle custody, native queue/preemption and packet-loop ownership without SQLite workers.
vi.mock("../../config/sessions/session-accessor.sqlite-entry-admission.js", () => ({
  loadSessionEntryForAdmission: boundary.load,
}));
// mock-isolation: The lifecycle boundary validates the supplied current-row check but acquires no real database writer.
vi.mock("../../sessions/session-lifecycle-admission.js", () => ({
  beginSessionWorkAdmission: boundary.admission,
}));
// mock-isolation: Packet persistence has native scenario coverage; this suite controls exact catch-up and cancellation outcomes.
vi.mock("./conversation-knowledge.js", () => ({
  prepareReplyConversationKnowledge: boundary.prepare,
}));
// mock-isolation: Observe summary-only maintenance parameters without invoking any model or provider runtime.
vi.mock("./conversation-knowledge-maintenance.js", () => ({
  resolveConversationKnowledgeContextLimits: () => ({ maxBytes: 1_000_000, maxEvents: 1_000 }),
  createConversationKnowledgeMaintenance: boundary.maintenance,
}));

function fixture(activeWriterRunId?: string) {
  const branch: ConversationKnowledgeBranch = {
    agentId: "main",
    sessionKey: "agent:main:idle-knowledge",
    sessionId: "idle-knowledge-session",
    lifecycleRevision: "idle-knowledge-life",
    storePath: path.resolve("test-state/idle-knowledge.sqlite"),
    root: { sessionKey: "agent:main:root", sessionId: "root", lifecycleRevision: "root-life" },
  };
  const participant = {
    type: "remote" as const,
    pluginId: "matrix",
    domain: "example.test",
    idKind: "user-id",
    id: "@person:example.test",
  };
  let audienceValid = true;
  const audience: ConversationPrivateAudience = {
    agentId: branch.agentId,
    sessionKey: branch.sessionKey,
    channelId: "matrix",
    accountId: "default",
    nativeChannelId: "synthetic-private-chat",
    participant,
    assertCurrent() {
      if (!audienceValid) {
        throw new Error("Synthetic audience revoked");
      }
    },
  };
  const entry: InternalSessionEntry = {
    sessionId: branch.sessionId,
    lifecycleRevision: branch.lifecycleRevision,
    activeWriterRunId,
    updatedAt: 1,
    conversationTopology: {
      version: 1,
      role: "branch",
      rootSessionKey: branch.root.sessionKey,
      rootSessionId: branch.root.sessionId,
      rootSessionLifecycleRevision: branch.root.lifecycleRevision,
    },
  };
  const release = vi.fn(async () => {});
  const admissionRelease = vi.fn();
  const reader = {
    async withRead(
      _request: unknown,
      assertCurrent: () => void,
      consume: (facts: unknown) => unknown,
    ) {
      assertCurrent();
      return consume({
        source: { path: branch.storePath },
        entries: [{ sessionKey: branch.sessionKey, entry }],
      });
    },
  };
  boundary.load.mockImplementation(async () => ({
    entry: { ...entry },
    databaseClaim: { kind: "worker", reader, assertCurrent() {}, release },
  }));
  boundary.admission.mockImplementation(async (request) => {
    await request.assertAllowed();
    return { run: async (run: () => Promise<unknown>) => await run(), release: admissionRelease };
  });
  boundary.prepare.mockResolvedValue({ pendingPackets: false, release() {} });
  boundary.maintenance.mockReturnValue(async () => ({ compacted: false, complete: true }));
  const cfg = {
    agents: {
      entries: {
        main: {
          conversationMode: "branches" as const,
          model: "test-provider/current-model",
          workspace: path.resolve("test-state/workspace"),
        },
      },
    },
  };
  return {
    branch,
    entry,
    release,
    admissionRelease,
    revokeAudience: () => {
      audienceValid = false;
    },
    params: {
      branch,
      participant,
      audience,
      env: {},
      getRuntimeConfig: () => cfg,
      run: {
        agentId: branch.agentId,
        sessionId: branch.sessionId,
        workspaceDir: path.resolve("test-state/workspace"),
        runId: "original-profile-diagnostic-id",
        timeoutMs: 1_000,
        prompt: "Do not execute this foreground prompt.",
        onAgentEvent: vi.fn(),
      },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("idle related-conversation hydration", () => {
  it.each([undefined, "completed-writer"])(
    "retains exact native writer absence/presence (%s) without a turn",
    async (writer) => {
      const f = fixture(writer);
      boundary.prepare.mockImplementation(async (request) => {
        const target = request.retainInHistory.writeTarget;
        expect(withOwnedSessionTranscriptWriterFence(f.branch)).toMatchObject({
          expectedOwner: {
            lifecycleRevision: f.branch.lifecycleRevision,
            activeWriterRunId: writer,
          },
        });
        await request.retainInHistory.maintainContext(() => {}, [], "Prospective quoted data.");
        const maintenance = boundary.maintenance.mock.calls[0]![0];
        expect(maintenance.run.prompt).toBe("");
        expect(maintenance.run.disableTools).toBe(true);
        expect(maintenance.run.onAgentEvent).toBeUndefined();
        expect(maintenance.run.modelFallbacksOverride).toEqual([]);
        const operation = vi.fn(async () => "summary-only");
        await expect(maintenance.withWriter(target, operation)).resolves.toBe("summary-only");
        await expect(
          maintenance.withWriter({ ...target, sessionId: "other" }, operation),
        ).rejects.toThrow("writer target changed");
        expect(operation).toHaveBeenCalledOnce();
        return { pendingPackets: false, release() {} };
      });
      await expect(runIdleConversationKnowledge(f.params)).resolves.toEqual({
        status: "settled",
        admittedPackets: 0,
      });
      expect(f.entry.activeWriterRunId).toBe(writer);
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.admissionRelease).toHaveBeenCalledOnce();
    },
  );

  it("continues chronological catch-up past a scheduling quantum without another input", async () => {
    const f = fixture();
    const offsets: number[] = [];
    boundary.prepare.mockImplementation(async (request) => {
      offsets.push(request.sourceOffset);
      const count = request.sourceOffset === 0 ? 32 : 3;
      for (let index = 0; index < count; index++) {
        request.onPacket();
      }
      return { pendingPackets: count === 32, nextSourceOffset: 32, release() {} };
    });
    await expect(runIdleConversationKnowledge(f.params)).resolves.toEqual({
      status: "settled",
      admittedPackets: 35,
    });
    expect(offsets).toEqual([0, 32]);
  });

  it("resolves the current session model when opening a recipient without any turn profile", async () => {
    const f = fixture();
    f.entry.providerOverride = "session-provider";
    f.entry.modelOverride = "session-model";
    boundary.prepare.mockImplementation(async (request) => {
      await request.retainInHistory.maintainContext(() => {});
      const run = boundary.maintenance.mock.calls[0]![0].run;
      expect(run.provider).toBe("session-provider");
      expect(run.model).toBe("session-model");
      expect(run.runId).toBe(f.branch.sessionId);
      expect(run.workspaceDir).toBe(path.resolve("test-state/workspace"));
      expect(run.prompt).toBe("");
      return { pendingPackets: false, release() {} };
    });
    await expect(
      runIdleConversationKnowledge({ ...f.params, run: undefined }),
    ).resolves.toMatchObject({ status: "settled" });
  });

  it("refuses a newly claimed writer rather than taking over its transcript", async () => {
    const f = fixture();
    boundary.admission.mockImplementation(async (request) => {
      f.entry.activeWriterRunId = "new-foreground-writer";
      await request.assertAllowed();
      throw new Error("Unexpected admission after writer replacement");
    });
    await expect(runIdleConversationKnowledge(f.params)).rejects.toThrow(
      "recipient ownership changed",
    );
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(f.entry.activeWriterRunId).toBe("new-foreground-writer");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("rechecks audience revocation after awaited preparation and releases its source", async () => {
    const f = fixture();
    const release = vi.fn();
    boundary.prepare.mockImplementation(async () => {
      f.revokeAudience();
      return { pendingPackets: false, release };
    });
    await expect(runIdleConversationKnowledge(f.params)).rejects.toThrow(
      "Synthetic audience revoked",
    );
    expect(release).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.admissionRelease).toHaveBeenCalledOnce();
  });

  it("keeps failed admission pending without cycling through offsets forever", async () => {
    const f = fixture();
    boundary.prepare.mockImplementation(async (request) => ({
      pendingPackets: true,
      nextSourceOffset: request.sourceOffset === 0 ? 32 : 0,
      release() {},
    }));
    await expect(runIdleConversationKnowledge(f.params)).resolves.toEqual({
      status: "pending",
      admittedPackets: 0,
    });
    expect(boundary.prepare).toHaveBeenCalledTimes(2);
  });

  it("yields to native foreground priority and reports a safe retry after cleanup", async () => {
    const f = fixture();
    const started = createDeferred();
    boundary.prepare.mockImplementation(async (request) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      request.signal.throwIfAborted();
    });
    const work = runIdleConversationKnowledge(f.params);
    await started.promise;
    const foreground = beginForegroundSessionMaintenance(f.branch.sessionKey);
    try {
      await expect(work).resolves.toEqual({
        status: "pending",
        admittedPackets: 0,
        preempted: true,
      });
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.admissionRelease).toHaveBeenCalledOnce();
    } finally {
      (await foreground)();
    }
  });

  it("joins native result cleanup before foreground admission or releasing database custody", async () => {
    const f = fixture();
    const nativeReturned = createDeferred();
    const finishCleanup = createDeferred();
    let nativeSignal: AbortSignal | undefined;
    let cleanupFinished = false;
    let custodyReleasedEarly = false;
    let followingModelAdmitted = false;
    f.admissionRelease.mockImplementation(() => {
      custodyReleasedEarly ||= !cleanupFinished;
    });
    f.release.mockImplementation(async () => {
      custodyReleasedEarly ||= !cleanupFinished;
    });
    boundary.maintenance.mockReturnValue(async () => {
      nativeSignal = getAsyncWorkSignal();
      // Native compactors return their result while this separately tracked
      // provider/tool disposal tail still owns accepted cleanup work.
      void captureAsyncWorkTracker()(async () => {
        await finishCleanup.promise;
        cleanupFinished = true;
      }).catch(() => {});
      nativeReturned.resolve();
      return { compacted: false, complete: true };
    });
    boundary.prepare.mockImplementation(async (request) => {
      await request.retainInHistory.maintainContext(() => {});
      return { pendingPackets: false, release() {} };
    });
    const work = runIdleConversationKnowledge(f.params);
    let foreground: Promise<() => void> | undefined;
    let followingModel: Promise<void> | undefined;
    let foregroundAdmitted = false;
    try {
      await nativeReturned.promise;
      expect(nativeSignal).toBeDefined();
      followingModel = enqueueCommandInLane(resolveGlobalLane(), async () => {
        followingModelAdmitted = true;
      });
      foreground = beginForegroundSessionMaintenance(f.branch.sessionKey).then((release) => {
        foregroundAdmitted = true;
        return release;
      });
      await Promise.resolve();
      expect(nativeSignal?.aborted).toBe(true);
      expect(f.admissionRelease).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
      expect(foregroundAdmitted).toBe(false);
      expect(followingModelAdmitted).toBe(false);
    } finally {
      finishCleanup.resolve();
      await work;
      await followingModel;
      (await foreground)?.();
    }
    expect(cleanupFinished).toBe(true);
    expect(custodyReleasedEarly).toBe(false);
    expect(f.admissionRelease).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(foregroundAdmitted).toBe(true);
    expect(followingModelAdmitted).toBe(true);
  });

  it.each([false, true])(
    "uses native global model admission and cancels queued maintenance on preemption (%s)",
    async (preempt) => {
      const f = fixture();
      const globalStarted = createDeferred();
      const finishGlobal = createDeferred();
      const requestedMaintenance = createDeferred();
      const occupied = enqueueCommandInLane(resolveGlobalLane(), async () => {
        globalStarted.resolve();
        await finishGlobal.promise;
      });
      await globalStarted.promise;
      boundary.prepare.mockImplementation(async (request) => {
        requestedMaintenance.resolve();
        await request.retainInHistory.maintainContext(() => {});
        return { pendingPackets: false, release() {} };
      });
      const work = runIdleConversationKnowledge(f.params);
      let foreground: Promise<() => void> | undefined;
      try {
        await requestedMaintenance.promise;
        expect(boundary.maintenance).not.toHaveBeenCalled();
        if (preempt) {
          foreground = beginForegroundSessionMaintenance(f.branch.sessionKey);
          await expect(work).resolves.toMatchObject({ status: "pending", preempted: true });
          expect(boundary.maintenance).not.toHaveBeenCalled();
        } else {
          finishGlobal.resolve();
          await expect(work).resolves.toMatchObject({ status: "settled" });
          expect(boundary.maintenance).toHaveBeenCalledOnce();
        }
      } finally {
        finishGlobal.resolve();
        await occupied;
        await work;
        (await foreground)?.();
      }
      expect(f.admissionRelease).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it.each(["Error", "AbortError"])(
    "does not hide a cleanup failure named %s behind foreground preemption",
    async (name) => {
      const f = fixture();
      const started = createDeferred();
      const cleanupError = Object.assign(new Error("Synthetic database release failed"), { name });
      let abortReason: unknown;
      f.release.mockRejectedValueOnce(cleanupError);
      boundary.prepare.mockImplementation(async (request) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        abortReason = request.signal.reason;
        request.signal.throwIfAborted();
      });
      const work = runIdleConversationKnowledge(f.params);
      await started.promise;
      const foreground = beginForegroundSessionMaintenance(f.branch.sessionKey);
      try {
        const failure: unknown = await work.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) {
          throw new Error("Expected both foreground abort and database cleanup failure");
        }
        expect(abortReason).toBeDefined();
        expect(failure.errors).toHaveLength(2);
        expect(failure.errors[0]).toBe(abortReason);
        expect(failure.errors[1]).toBe(cleanupError);
        expect(failure.cause).toBe(cleanupError);
        expect(f.admissionRelease).toHaveBeenCalledOnce();
        expect(f.release).toHaveBeenCalledOnce();
      } finally {
        (await foreground)();
      }
    },
  );

  it("does not turn external cancellation or audience revocation into automatic retries", async () => {
    const f = fixture();
    const controller = new AbortController();
    const cancellation = new Error("Explicit stop");
    boundary.prepare.mockImplementation(async () => {
      controller.abort(cancellation);
      controller.signal.throwIfAborted();
    });
    await expect(
      runIdleConversationKnowledge({ ...f.params, signal: controller.signal }),
    ).rejects.toBe(cancellation);
    f.revokeAudience();
    await expect(runIdleConversationKnowledge(f.params)).rejects.toThrow(
      "Synthetic audience revoked",
    );
  });
});
