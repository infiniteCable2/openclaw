import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { createConversationKnowledgePrefetchOwner } from "./conversation-knowledge-prefetch-owner.js";

const boundary = vi.hoisted(() => ({
  register: vi.fn<(resource: OpenClawAgentDatabaseAsyncResource) => () => void>(),
  capture: vi.fn<
    (target: { agentId: string; path: string; env?: NodeJS.ProcessEnv }) => {
      assertCurrent(): void;
      release(): Promise<void>;
    }
  >(),
  enqueue:
    vi.fn<
      (
        task: (signal: AbortSignal) => Promise<void>,
        options: { abortSignal: AbortSignal },
      ) => Promise<void>
    >(),
  warn: vi.fn(),
}));

// mock-isolation: Test ownership and settlement without native databases or process-wide close fences.
vi.mock("../../state/openclaw-agent-db-resources.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: boundary.register,
}));
// mock-isolation: Control exact generation revocation and native release failure independently of storage.
vi.mock("../../state/openclaw-agent-execution.js", () => ({
  captureOpenClawAgentDatabaseExecution: boundary.capture,
}));
// mock-isolation: Exercise the leaf admission contract without starting global command queues.
vi.mock("../../process/background-work.js", () => ({
  createBackgroundWorkOwner: () => ({ enqueue: boundary.enqueue }),
}));
// mock-isolation: Capture content-free diagnostics without creating application log files.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: boundary.warn }),
}));

const target = {
  agentId: "example",
  storePath: path.resolve("synthetic-prefetch.sqlite"),
  sessionKey: "agent:example:branch",
  sessionId: "recipient-session",
  root: {
    sessionKey: "agent:example:root",
    sessionId: "root-session",
    lifecycleRevision: "root-life",
  },
};
const resources = new Set<OpenClawAgentDatabaseAsyncResource>();
const releaseGates = new Set<() => void>();

function gate() {
  const deferred = createDeferredCore();
  releaseGates.add(() => deferred.resolve());
  return deferred;
}

function rootUpdate(
  overrides: Partial<NonNullable<Parameters<typeof emitSessionTranscriptUpdate>[0]["target"]>> = {},
) {
  emitSessionTranscriptUpdate({
    target: {
      agentId: target.agentId,
      storePath: target.storePath,
      sessionId: target.root.sessionId,
      sessionKey: target.root.sessionKey,
      ...overrides,
    },
    lifecycleRevision: target.root.lifecycleRevision,
  });
}

function fixture() {
  const prepare = vi.fn(async (_signal: AbortSignal) => {});
  const clear = vi.fn();
  const assertCurrent = vi.fn();
  const owner = createConversationKnowledgePrefetchOwner({ target, prepare, clear, assertCurrent });
  return { owner, prepare, clear, assertCurrent };
}

beforeEach(() => {
  vi.resetAllMocks();
  boundary.capture.mockImplementation(() => ({
    assertCurrent() {},
    release: async () => {},
  }));
  boundary.register.mockImplementation((resource) => {
    resources.add(resource);
    return () => resources.delete(resource);
  });
  boundary.enqueue.mockImplementation(async (task, options) => {
    options.abortSignal.throwIfAborted();
    await task(options.abortSignal);
  });
});

afterEach(async () => {
  for (const release of releaseGates) {
    release();
  }
  releaseGates.clear();
  for (const resource of resources) {
    resource.revoke();
    await resource.close();
  }
  expect(resources.size).toBe(0);
  vi.useRealTimers();
});

describe("conversation knowledge prefetch lifecycle", () => {
  it("coalesces committed recipient metadata into detached data preparation", async () => {
    const context = new AsyncLocalStorage<string>();
    const prepare = vi.fn(async () => {
      expect(context.getStore()).toBeUndefined();
    });
    const owner = createConversationKnowledgePrefetchOwner({
      target,
      assertCurrent() {},
      clear() {},
      prepare,
    });
    await owner.wait();
    const change = {
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: target.sessionKey,
      scope: "session-entry" as const,
    };
    context.run("delivery-publisher", () => {
      sessionChanges.emit(change);
      sessionChanges.emit(change);
      expect(prepare).toHaveBeenCalledOnce();
    });
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(2);
    sessionChanges.emit({ ...change, scope: "transcript" });
    sessionChanges.emit({ ...change, scope: "runtime" });
    sessionChanges.emit({ ...change, agentId: "other" });
    sessionChanges.emit({ ...change, storePath: path.resolve("other.sqlite") });
    sessionChanges.emit({ ...change, sessionKey: target.root.sessionKey });
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(2);
    await owner.close();
    sessionChanges.emit(change);
    owner.request();
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("continues source pages and preserves new root wakeups", async () => {
    let pages = 0;
    const prepare = vi.fn(async () => {
      pages++;
      if (pages === 2) {
        rootUpdate();
      }
      return pages < 4;
    });
    const owner = createConversationKnowledgePrefetchOwner({
      target,
      assertCurrent() {},
      clear() {},
      prepare,
    });
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(4);
    await owner.close();
  });

  it("does not revive revoked recipient authority from a committed delivery notification", async () => {
    let live = true;
    const prepare = vi.fn(async () => {});
    const owner = createConversationKnowledgePrefetchOwner({
      target,
      assertCurrent() {
        if (!live) {
          throw new Error("Synthetic private opening revoked");
        }
      },
      clear() {},
      prepare,
    });
    await owner.wait();
    live = false;
    expect(() =>
      sessionChanges.emit({
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKey: target.sessionKey,
        scope: "session-entry",
      }),
    ).not.toThrow();
    await owner.close();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("starts detached and nonblocking, then coalesces exact root notifications", async () => {
    const context = new AsyncLocalStorage<string>();
    const observed: Array<string | undefined> = [];
    const prepare = vi.fn(async () => {
      observed.push(context.getStore());
    });
    const clear = vi.fn();
    const env = { OPENCLAW_STATE_DIR: "original-state" };
    const owner = context.run("publisher", () =>
      createConversationKnowledgePrefetchOwner({
        target: { ...target, env },
        assertCurrent() {},
        prepare,
        clear,
      }),
    );
    expect(prepare).not.toHaveBeenCalled();
    env.OPENCLAW_STATE_DIR = "replacement-state";
    rootUpdate();
    rootUpdate();
    expect(prepare).not.toHaveBeenCalled();
    await owner.wait();
    expect(prepare).toHaveBeenCalledOnce();
    expect(observed).toEqual([undefined]);
    expect(boundary.capture.mock.calls[0]?.[0].env).toEqual({
      OPENCLAW_STATE_DIR: "original-state",
    });
    expect(clear).not.toHaveBeenCalled();
    rootUpdate();
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(clear).not.toHaveBeenCalled();
  });

  it("ignores other roots, physical stores, agents and incomplete target metadata", async () => {
    const f = fixture();
    await f.owner.wait();
    rootUpdate({ agentId: "other" });
    rootUpdate({ sessionId: "other-session" });
    rootUpdate({ sessionKey: "agent:example:other-root" });
    rootUpdate({ storePath: path.resolve("other-prefetch.sqlite") });
    rootUpdate({ storePath: undefined });
    await f.owner.wait();
    expect(f.prepare).toHaveBeenCalledOnce();
  });

  it("runs neither scope checks nor preparation on the root publisher stack", async () => {
    const f = fixture();
    await f.owner.wait();
    f.assertCurrent.mockClear();
    f.prepare.mockClear();
    rootUpdate();
    expect(f.assertCurrent).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    await f.owner.wait();
    expect(f.assertCurrent).toHaveBeenCalled();
    expect(f.prepare).toHaveBeenCalledOnce();
  });

  it("preserves notifications during preparation without canceling reusable ranges", async () => {
    const began = createDeferredCore();
    const finish = gate();
    const f = fixture();
    f.prepare.mockImplementationOnce(async (signal) => {
      began.resolve();
      await finish.promise;
      expect(signal.aborted).toBe(false);
    });
    await began.promise;
    rootUpdate();
    rootUpdate();
    expect(f.clear).not.toHaveBeenCalled();
    finish.resolve();
    await f.owner.wait();
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(boundary.enqueue).toHaveBeenCalledTimes(2);
  });

  it("retries a read failure without erasing valid cached ranges", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    f.prepare.mockRejectedValueOnce(new Error("synthetic source changed"));
    await f.owner.wait();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.clear).not.toHaveBeenCalled();
    expect(boundary.warn).toHaveBeenCalledWith(expect.any(String), {
      errorCode: "preparation-deferred",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await f.owner.wait();
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(boundary.warn.mock.calls)).not.toContain("synthetic source changed");
  });

  it("joins actual preparation before native release and cannot resurrect a closed owner", async () => {
    const began = createDeferredCore();
    const finish = gate();
    const release = vi.fn(async () => {});
    boundary.capture.mockReturnValue({ assertCurrent() {}, release });
    const f = fixture();
    let signal: AbortSignal | undefined;
    f.prepare.mockImplementationOnce(async (activeSignal) => {
      signal = activeSignal;
      began.resolve();
      await finish.promise;
    });
    await began.promise;
    const closing = f.owner.close();
    expect(signal?.aborted).toBe(true);
    expect(f.clear).toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    rootUpdate();
    f.owner.request();
    finish.resolve();
    await closing;
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(resources.size).toBe(0);
    expect(() => f.owner.assertCurrent()).toThrow();
  });

  it("clears revoked authority without throwing into root publication", async () => {
    const f = fixture();
    await f.owner.wait();
    f.assertCurrent.mockImplementation(() => {
      throw new Error("synthetic revoked audience");
    });
    expect(() => rootUpdate()).not.toThrow();
    await f.owner.close();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.clear).toHaveBeenCalled();
    expect(resources.size).toBe(0);
  });

  it("keeps failed native cleanup registered until the lifecycle retries", async () => {
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic release failed"))
      .mockResolvedValue(undefined);
    boundary.capture.mockReturnValue({ assertCurrent() {}, release });
    const f = fixture();
    await f.owner.wait();
    await expect(f.owner.close()).rejects.toThrow("synthetic release failed");
    expect(resources.size).toBe(1);
    f.owner.request();
    await [...resources][0]!.close();
    expect(release).toHaveBeenCalledTimes(2);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(resources.size).toBe(0);
  });

  it("releases registration when native generation capture refuses", () => {
    boundary.capture.mockImplementationOnce(() => {
      throw new Error("synthetic unavailable generation");
    });
    expect(() => fixture()).toThrow("synthetic unavailable generation");
    expect(resources.size).toBe(0);
    expect(boundary.enqueue).not.toHaveBeenCalled();
  });
});
