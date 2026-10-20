import { describe, expect, it, vi } from "vitest";
import {
  ConversationPublicationBlockedError,
  drainConversationPublications,
  type ConversationPublicationDrainStore,
} from "./conversation-publication-drain.js";
import type { ConversationPublicationRow } from "./conversation-publication.types.js";

function row(id: string): ConversationPublicationRow {
  return {
    id,
    intent: {
      version: 1,
      kind: "completed-turn",
      runId: `run-${id}`,
      sourceMode: "branches",
      source: { sessionKey: `agent:example:${id}`, sessionId: id, lifecycleRevision: "branch-v1" },
      root: { sessionKey: "agent:example:root", sessionId: "root", lifecycleRevision: "root-v1" },
    },
    anchor: {
      agentId: "example",
      sessionKey: `agent:example:${id}`,
      sessionId: id,
      storePath: "/example/agent.sqlite",
      generation: "generation-1",
      rawSeq: 2,
      entryId: `terminal-${id}`,
      activeMessagePosition: 1,
      effectiveParentId: "question",
    },
    state: "ready",
    attemptCount: 0,
    nextAttemptAt: 0,
  };
}

function fixture(rows: ConversationPublicationRow[]) {
  const store = {
    readReadyHeads: vi.fn(async () => rows),
    acknowledge: vi.fn(async (_id: string) => {}),
    retry: vi.fn(async (_id: string, _input: { errorCode: string; nextAttemptAt: number }) => {}),
    block: vi.fn(async (_id: string, _input: { errorCode: string }) => {}),
  } satisfies ConversationPublicationDrainStore;
  return {
    store,
    publish: vi.fn(async (_row: ConversationPublicationRow) => {}),
    assertCurrent: vi.fn(),
    now: () => 10_000,
    warn: vi.fn(),
  };
}

describe("durable conversation publication drainage", () => {
  it("acknowledges only after root publication and bounds each batch", async () => {
    const test = fixture([row("a")]);
    const order: string[] = [];
    test.publish.mockImplementation(async () => {
      order.push("published");
    });
    test.store.acknowledge.mockImplementation(async () => {
      order.push("acknowledged");
    });
    await expect(drainConversationPublications(test)).resolves.toBe(1);
    expect(order).toEqual(["published", "acknowledged"]);
    expect(test.store.readReadyHeads).toHaveBeenCalledWith({ now: 10_000, limit: 8 });
    expect(test.store.retry).not.toHaveBeenCalled();
  });

  it("retains a failed branch and still publishes another branch without logging content", async () => {
    const test = fixture([row("a"), row("b")]);
    test.publish.mockRejectedValueOnce(new Error("private message and path must not leak"));
    await drainConversationPublications(test);
    expect(test.store.retry).toHaveBeenCalledWith("a", {
      errorCode: "publication-failed",
      nextAttemptAt: 11_000,
    });
    expect(test.store.acknowledge).toHaveBeenCalledExactlyOnceWith("b");
    expect(JSON.stringify(test.warn.mock.calls)).not.toContain("private message");
  });

  it("backs off repeatedly failing rows without an unbounded delay", async () => {
    const first = row("a");
    first.attemptCount = 2;
    const old = row("b");
    old.attemptCount = 10_000;
    const test = fixture([first, old]);
    test.publish.mockRejectedValue(new Error("unavailable"));
    await drainConversationPublications(test);
    expect(test.store.retry.mock.calls).toEqual([
      ["a", { errorCode: "publication-failed", nextAttemptAt: 14_000 }],
      ["b", { errorCode: "publication-failed", nextAttemptAt: 310_000 }],
    ]);
  });

  it("keeps a replaced source explicitly blocked instead of marking it delivered", async () => {
    const test = fixture([row("a")]);
    test.publish.mockRejectedValue(new ConversationPublicationBlockedError("source-replaced"));
    await drainConversationPublications(test);
    expect(test.store.block).toHaveBeenCalledExactlyOnceWith("a", {
      errorCode: "source-replaced",
    });
    expect(test.store.acknowledge).not.toHaveBeenCalled();
    expect(test.store.retry).not.toHaveBeenCalled();
  });

  it("retries lost acknowledgments using the same publication identity", async () => {
    const test = fixture([row("a")]);
    const root = new Set<string>();
    test.publish.mockImplementation(async (job) => {
      root.add(job.id);
    });
    test.store.acknowledge.mockRejectedValueOnce(new Error("reply lost after root commit"));
    await drainConversationPublications(test);
    expect(test.store.retry).toHaveBeenCalledOnce();
    await drainConversationPublications(test);
    expect(root.size).toBe(1);
    expect(test.publish.mock.calls.map(([job]) => job.id)).toEqual(["a", "a"]);
    expect(test.store.acknowledge).toHaveBeenCalledTimes(2);
  });

  it("cannot acknowledge or requeue through revoked owner authority", async () => {
    const test = fixture([row("a")]);
    let current = true;
    test.assertCurrent.mockImplementation(() => {
      if (!current) {
        throw new Error("revoked");
      }
    });
    test.publish.mockImplementation(async () => {
      current = false;
    });
    await expect(drainConversationPublications(test)).rejects.toThrow("revoked");
    expect(test.store.acknowledge).not.toHaveBeenCalled();
    expect(test.store.retry).not.toHaveBeenCalled();
    expect(test.store.block).not.toHaveBeenCalled();
  });

  it("leaves the original journal authoritative if persisting a retry fails", async () => {
    const test = fixture([row("a")]);
    test.publish.mockRejectedValue(new Error("publication offline"));
    test.store.retry.mockRejectedValue(new Error("journal offline"));
    await expect(drainConversationPublications(test)).rejects.toThrow("journal offline");
    expect(test.store.acknowledge).not.toHaveBeenCalled();
    expect(test.warn).not.toHaveBeenCalled();
  });
});
