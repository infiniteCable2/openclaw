import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  startConversationKnowledgePublication,
  waitForConversationKnowledgePublication,
} from "./conversation-publication-reconcile.js";
import type { ConversationPublicationRow } from "./conversation-publication.types.js";

const boundary = vi.hoisted(() => ({
  yield: vi.fn<() => Promise<void>>(),
  register: vi.fn<(resource: OpenClawAgentDatabaseAsyncResource) => () => void>(),
  capture: vi.fn<
    (target: { agentId: string; path: string; env?: NodeJS.ProcessEnv }) => {
      assertCurrent(): void;
      release(): Promise<void>;
    }
  >(),
  open: vi.fn(),
  publish: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("node:timers/promises", () => ({ setImmediate: boundary.yield }));
// mock-isolation: Exercise resource ownership without native databases, workers or global close fences.
vi.mock("../../state/openclaw-agent-db-resources.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: boundary.register,
}));
// mock-isolation: Precisely control native release settlement and failure without opening a database.
vi.mock("../../state/openclaw-agent-execution.js", () => ({
  captureOpenClawAgentDatabaseExecution: boundary.capture,
}));
// mock-isolation: Supply the durable journal seam; the actual drain still owns acknowledgment order.
vi.mock("./conversation-publication.js", () => ({
  openConversationPublicationStore: boundary.open,
}));
// mock-isolation: Observe root publication without reading private transcripts or running models.
vi.mock("./conversation-publication-publish.js", () => ({
  publishConversationPublication: boundary.publish,
}));
// mock-isolation: Observe content-free failures without initializing application log files.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: boundary.warn }),
}));

const target = {
  agentId: "example",
  path: path.resolve("synthetic-publication.sqlite"),
  env: { OPENCLAW_STATE_DIR: "original-state" },
};
const resources = new Set<OpenClawAgentDatabaseAsyncResource>();
const releaseGates = new Set<() => void>();

function gate() {
  const deferred = createDeferredCore();
  releaseGates.add(() => deferred.resolve());
  return deferred;
}

function pendingRow(): ConversationPublicationRow {
  return {
    id: "saved-publication",
    intent: {
      version: 1,
      kind: "completed-turn",
      runId: "saved-run",
      sourceMode: "branches",
      source: {
        sessionKey: "agent:example:branch",
        sessionId: "source-session",
        lifecycleRevision: "source-life",
      },
      root: {
        sessionKey: "agent:example:root",
        sessionId: "root-session",
        lifecycleRevision: "root-life",
      },
    },
    anchor: {
      agentId: target.agentId,
      storePath: target.path,
      sessionKey: "agent:example:branch",
      sessionId: "source-session",
      generation: "original-generation",
      entryId: "saved-terminal",
      rawSeq: 2,
      activeMessagePosition: 1,
      effectiveParentId: "saved-user",
    },
    state: "ready",
    attemptCount: 0,
    nextAttemptAt: 0,
  };
}

function fixture() {
  const rows: ConversationPublicationRow[] = [];
  const store = {
    stats: vi.fn(async () => [
      { state: "candidate", count: 1 },
      { state: "blocked", count: 2 },
      { state: "ready", count: rows.length },
    ]),
    readReadyHeads: vi.fn(async () => [...rows]),
    nextAttemptAt: vi.fn(async () => (rows.length ? 0 : undefined)),
    acknowledge: vi.fn(async (id: string) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) {
        rows.splice(index, 1);
      }
    }),
    retry: vi.fn(async () => {}),
    block: vi.fn(async () => {}),
  };
  boundary.open.mockReturnValue(store);
  return { rows, store };
}

beforeEach(() => {
  vi.resetAllMocks();
  boundary.yield.mockResolvedValue();
  boundary.publish.mockResolvedValue(undefined);
  boundary.capture.mockImplementation(() => ({
    assertCurrent() {},
    release: async () => {},
  }));
  boundary.register.mockImplementation((resource) => {
    resources.add(resource);
    return () => {
      resources.delete(resource);
    };
  });
});

afterEach(async () => {
  try {
    for (const resolve of releaseGates) {
      resolve();
    }
    releaseGates.clear();
    for (const resource of resources) {
      resource.revoke();
      await resource.close();
    }
    expect(resources.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

describe("conversation publication reconciliation ownership", () => {
  it("starts nonblocking and recovers saved work using the captured environment", async () => {
    const f = fixture();
    f.rows.push(pendingRow());
    const begin = gate();
    boundary.yield.mockImplementationOnce(() => begin.promise);
    const input = { ...target, env: { ...target.env }, reportPending: true };
    expect(startConversationKnowledgePublication(input)).toBeUndefined();
    expect(boundary.capture).toHaveBeenCalledOnce();
    expect(boundary.publish).not.toHaveBeenCalled();
    input.env.OPENCLAW_STATE_DIR = "replacement-state";
    begin.resolve();
    await waitForConversationKnowledgePublication(target);
    expect(boundary.publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        row: pendingRow(),
        env: { OPENCLAW_STATE_DIR: "original-state" },
      }),
    );
    expect(f.store.acknowledge).toHaveBeenCalledExactlyOnceWith("saved-publication");
    expect(f.store.stats).toHaveBeenCalledOnce();
    expect(boundary.warn).toHaveBeenCalledWith(expect.stringContaining("unconfirmed or blocked"), {
      agentId: target.agentId,
      states: [
        { state: "candidate", count: 1 },
        { state: "blocked", count: 2 },
      ],
    });
    expect(boundary.capture.mock.calls[0]?.[0].env).toEqual(target.env);
    expect(resources.size).toBe(0);
  });

  it("hands a release-time wakeup to a successor only after native release finishes", async () => {
    const f = fixture();
    const releasing = createDeferredCore();
    const released = gate();
    let nativeReleased = false;
    boundary.capture.mockImplementationOnce(() => ({
      assertCurrent() {},
      async release() {
        releasing.resolve();
        await released.promise;
        nativeReleased = true;
      },
    }));
    boundary.capture.mockImplementationOnce(() => {
      expect(nativeReleased).toBe(true);
      return { assertCurrent() {}, release: async () => {} };
    });
    startConversationKnowledgePublication(target);
    await releasing.promise;
    const joined = waitForConversationKnowledgePublication(target);
    f.rows.push(pendingRow());
    startConversationKnowledgePublication({ ...target, reportPending: true });
    expect(boundary.capture).toHaveBeenCalledOnce();
    expect(boundary.publish).not.toHaveBeenCalled();
    released.resolve();
    await joined;
    expect(boundary.capture).toHaveBeenCalledTimes(2);
    expect(boundary.publish).toHaveBeenCalledOnce();
    expect(f.store.stats).toHaveBeenCalledOnce();
    expect(f.rows).toEqual([]);
    expect(resources.size).toBe(0);
  });

  it("does not restart a revoked owner even when it receives a release-time wakeup", async () => {
    const f = fixture();
    const releasing = createDeferredCore();
    const released = gate();
    boundary.capture.mockReturnValue({
      assertCurrent() {},
      async release() {
        releasing.resolve();
        await released.promise;
      },
    });
    startConversationKnowledgePublication(target);
    await releasing.promise;
    const resource = [...resources][0]!;
    resource.revoke();
    const closing = resource.close();
    f.rows.push(pendingRow());
    startConversationKnowledgePublication(target);
    released.resolve();
    await closing;
    await waitForConversationKnowledgePublication(target);
    expect(boundary.capture).toHaveBeenCalledOnce();
    expect(boundary.publish).not.toHaveBeenCalled();
    expect(f.rows).toHaveLength(1);
    expect(resources.size).toBe(0);
  });

  it("retains failed cleanup custody and admits no successor before native retry succeeds", async () => {
    const f = fixture();
    const failure = new Error("Native release failed");
    const release = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    boundary.capture.mockReturnValue({ assertCurrent() {}, release });
    startConversationKnowledgePublication(target);
    await expect(waitForConversationKnowledgePublication(target)).rejects.toBe(failure);
    expect(resources.size).toBe(1);
    f.rows.push(pendingRow());
    startConversationKnowledgePublication(target);
    expect(boundary.capture).toHaveBeenCalledOnce();
    const resource = [...resources][0]!;
    resource.revoke();
    await resource.close();
    expect(release).toHaveBeenCalledTimes(2);
    expect(boundary.publish).not.toHaveBeenCalled();
    expect(resources.size).toBe(0);
    startConversationKnowledgePublication(target);
    await waitForConversationKnowledgePublication(target);
    expect(boundary.capture).toHaveBeenCalledTimes(2);
    expect(f.rows).toEqual([]);
  });

  it("joins an in-flight publication on close without acknowledging through revoked custody", async () => {
    const f = fixture();
    f.rows.push(pendingRow());
    const publishing = createDeferredCore();
    const published = gate();
    const release = vi.fn(async () => {});
    boundary.capture.mockReturnValue({ assertCurrent() {}, release });
    boundary.publish.mockImplementationOnce(async () => {
      publishing.resolve();
      await published.promise;
    });
    startConversationKnowledgePublication(target);
    await publishing.promise;
    const resource = [...resources][0]!;
    resource.revoke();
    const closing = resource.close();
    expect(release).not.toHaveBeenCalled();
    published.resolve();
    await closing;
    expect(f.store.acknowledge).not.toHaveBeenCalled();
    expect(f.store.retry).not.toHaveBeenCalled();
    expect(f.rows).toHaveLength(1);
    expect(release).toHaveBeenCalledOnce();
    expect(resources.size).toBe(0);
  });

  it("backs off journal failures instead of busy-looping", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const warned = createDeferredCore();
    f.store.readReadyHeads.mockRejectedValueOnce(new Error("Storage unavailable"));
    boundary.warn.mockImplementationOnce(() => warned.resolve());
    startConversationKnowledgePublication(target);
    await warned.promise;
    expect(f.store.readReadyHeads).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(f.store.readReadyHeads).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await waitForConversationKnowledgePublication(target);
    expect(f.store.readReadyHeads).toHaveBeenCalledTimes(2);
    expect(resources.size).toBe(0);
  });

  it("retains the startup diagnostic request after a failed statistics read", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const warned = createDeferredCore();
    f.store.stats.mockRejectedValueOnce(new Error("Storage unavailable"));
    boundary.warn.mockImplementationOnce(() => warned.resolve());
    startConversationKnowledgePublication({ ...target, reportPending: true });
    await warned.promise;
    expect(f.store.stats).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForConversationKnowledgePublication(target);
    expect(f.store.stats).toHaveBeenCalledTimes(2);
    expect(boundary.warn).toHaveBeenCalledWith(expect.stringContaining("unconfirmed or blocked"), {
      agentId: target.agentId,
      states: [
        { state: "candidate", count: 1 },
        { state: "blocked", count: 2 },
      ],
    });
  });
});
