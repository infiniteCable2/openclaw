import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { createConversationKnowledgePrefetchOwner } from "./conversation-knowledge-prefetch-owner.js";

const boundary = vi.hoisted(() => ({
  register: vi.fn<(resource: OpenClawAgentDatabaseAsyncResource) => () => void>(),
  capture: vi.fn(() => ({ assertCurrent() {}, release: async () => {} })),
}));

// mock-isolation: Exercise the real background queue without opening native agent databases.
vi.mock("../../state/openclaw-agent-db-resources.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: boundary.register,
}));
// mock-isolation: The fixture owns generation lifetime, not storage or credentials.
vi.mock("../../state/openclaw-agent-execution.js", () => ({
  captureOpenClawAgentDatabaseExecution: boundary.capture,
}));
// mock-isolation: Keep synthetic queue scenarios from creating application log files.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug() {}, warn() {}, error() {}, info() {} }),
}));
// mock-isolation: Retain the actual queue while suppressing its external diagnostics.
vi.mock("../../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const target = {
  agentId: "example",
  storePath: path.resolve("synthetic-recipient-scenario.sqlite"),
  sessionKey: "agent:example:branch",
  sessionId: "recipient-session",
  root: {
    sessionKey: "agent:example:root",
    sessionId: "root-session",
    lifecycleRevision: "root-life",
  },
};
const resources = new Set<OpenClawAgentDatabaseAsyncResource>();
const releases = new Set<() => void>();

function gate() {
  const deferred = createDeferredCore();
  releases.add(() => deferred.resolve());
  return deferred;
}

function rootUpdate() {
  emitSessionTranscriptUpdate({
    target: { ...target, sessionKey: target.root.sessionKey, sessionId: target.root.sessionId },
    lifecycleRevision: target.root.lifecycleRevision,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCommandQueueStateForTest();
  boundary.capture.mockImplementation(() => ({ assertCurrent() {}, release: async () => {} }));
  boundary.register.mockImplementation((resource) => {
    resources.add(resource);
    return () => resources.delete(resource);
  });
});

afterEach(async () => {
  releases.forEach((release) => release());
  releases.clear();
  for (const resource of resources) {
    resource.revoke();
    await resource.close();
  }
  expect(resources.size).toBe(0);
  vi.useRealTimers();
  resetCommandQueueStateForTest();
});

describe("automatic recipient preparation scenarios", () => {
  it("recovers a transient read failure without another input or notification", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const prepare = vi.fn(async (_signal: AbortSignal) => {});
    prepare.mockRejectedValueOnce(new Error("synthetic transient read failure"));
    const owner = createConversationKnowledgePrefetchOwner({
      target,
      prepare,
      assertCurrent() {},
      clear() {},
    });
    // wait() joins accepted work and must not hang on a future retry timer.
    await owner.wait();
    expect(prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("coalesces fresh notifications and replaces a scheduled retry immediately", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const prepare = vi.fn(async () => {});
    prepare.mockRejectedValueOnce(new Error("synthetic transient read failure"));
    const owner = createConversationKnowledgePrefetchOwner({
      target,
      prepare,
      assertCurrent() {},
      clear() {},
    });
    await owner.wait();
    rootUpdate();
    rootUpdate();
    sessionChanges.emit({
      ...target,
      scope: "session-entry",
    });
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("bounds repeated failure backoff and resets it after recovery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let failing = true;
    const prepare = vi.fn(async () => {
      if (failing) {
        throw new Error("synthetic transient read failure");
      }
    });
    const owner = createConversationKnowledgePrefetchOwner({
      target,
      prepare,
      assertCurrent() {},
      clear() {},
    });
    await owner.wait();
    let attempts = 1;
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(prepare).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      await owner.wait();
      attempts++;
      expect(prepare).toHaveBeenCalledTimes(attempts);
    }
    failing = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await owner.wait();
    failing = true;
    owner.request();
    await owner.wait();
    const beforeRetry = prepare.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(beforeRetry + 1);
  });

  it("retains updates during a final preparation quantum and after its settlement", async () => {
    const began = gate();
    const finish = gate();
    const prepare = vi.fn(async () => {});
    prepare.mockImplementationOnce(async () => {
      began.resolve();
      await finish.promise;
      rootUpdate();
    });
    const owner = createConversationKnowledgePrefetchOwner({
      target,
      prepare,
      assertCurrent() {},
      clear() {},
    });
    await began.promise;
    rootUpdate();
    finish.resolve();
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(2);
    // A notification from a settlement observer must start a new owner quantum.
    await owner.wait().then(() => rootUpdate());
    await owner.wait();
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it("cancels retry on close and never revives a revoked audience", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let current = true;
    const prepare = vi.fn(async () => {
      throw new Error("synthetic transient read failure");
    });
    const clear = vi.fn();
    const owner = createConversationKnowledgePrefetchOwner({
      target,
      prepare,
      clear,
      assertCurrent() {
        if (!current) {
          throw new Error("synthetic audience revoked");
        }
      },
    });
    await owner.wait();
    current = false;
    rootUpdate();
    await owner.close();
    await vi.advanceTimersByTimeAsync(60_000);
    rootUpdate();
    owner.request();
    await owner.wait();
    expect(prepare).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalled();
    expect(resources.size).toBe(0);
  });

  it("shares real background capacity fairly across twenty reusable recipients", async () => {
    const began = gate();
    const finish = gate();
    const order: number[] = [];
    const owners: ReturnType<typeof createConversationKnowledgePrefetchOwner>[] = [];
    const counts = Array.from({ length: 20 }, () => 0);
    const create = (index: number) =>
      createConversationKnowledgePrefetchOwner({
        target: {
          ...target,
          sessionKey: `agent:example:branch-${index}`,
          sessionId: `recipient-${index}`,
        },
        assertCurrent() {},
        clear() {},
        async prepare() {
          order.push(index);
          counts[index]!++;
          if (index === 0 && counts[index] === 1) {
            began.resolve();
            await finish.promise;
          }
          return counts[index]! < 3;
        },
      });
    owners.push(create(0));
    await began.promise;
    for (let index = 1; index < counts.length; index++) {
      owners.push(create(index));
    }
    // Background preparation owns no foreground queue capacity.
    await expect(enqueueCommandInLane("main", async () => "foreground")).resolves.toBe(
      "foreground",
    );
    finish.resolve();
    await Promise.all(owners.map((owner) => owner.wait()));
    expect(order.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(counts).toEqual(Array.from({ length: 20 }, () => 3));
  });
});
