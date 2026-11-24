import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createConversationKnowledgeCheckpointFrameSlot } from "./conversation-knowledge-checkpoint-frame.js";

function fixture() {
  let current = true;
  return {
    frame: {
      assertCurrent() {
        if (!current) {
          throw new Error("Original broker permission ended");
        }
      },
      release: vi.fn(async () => {}),
    },
    release: vi.fn(async () => {}),
    revoke() {
      current = false;
    },
  };
}

describe("root preparation custody", () => {
  it("keeps a replaced frame alive until both native copies release their leases", async () => {
    const slot =
      createConversationKnowledgeCheckpointFrameSlot<ReturnType<typeof fixture>["frame"]>();
    const first = fixture(),
      second = fixture();
    slot.publish(first.frame, first.release);
    const left = slot.acquire()!,
      right = slot.acquire()!;
    slot.publish(second.frame, second.release);
    await slot.settle();
    expect(first.frame.release).not.toHaveBeenCalled();
    await left.release();
    expect(first.release).not.toHaveBeenCalled();
    await right.release();
    await right.release();
    expect(first.frame.release).toHaveBeenCalledOnce();
    expect(first.release).toHaveBeenCalledOnce();
    const next = slot.acquire()!;
    expect(next.frame).toBe(second.frame);
    slot.clear();
    await next.release();
    await slot.settle(true);
    expect(second.release).toHaveBeenCalledOnce();
  });

  it("retires revoked original-broker custody instead of borrowing another broker's permission", async () => {
    const slot =
      createConversationKnowledgeCheckpointFrameSlot<ReturnType<typeof fixture>["frame"]>();
    const source = fixture();
    slot.publish(source.frame, source.release);
    source.revoke();
    expect(slot.acquire()).toBeUndefined();
    await slot.settle();
    expect(source.frame.release).toHaveBeenCalledOnce();
    expect(source.release).toHaveBeenCalledOnce();
  });

  it("lets callers share an in-flight publication while one caller cancels independently", async () => {
    const slot =
      createConversationKnowledgeCheckpointFrameSlot<ReturnType<typeof fixture>["frame"]>();
    const stale = fixture();
    const fresh = fixture();
    const preparing = createDeferredCore();
    const caller = new AbortController();
    const matches = (frame: typeof fresh.frame) => frame === fresh.frame;
    slot.publish(stale.frame, stale.release);
    const inFlight = () => preparing.promise;
    const cancelled = slot.waitFor(matches, inFlight, caller.signal);
    const remaining = slot.waitFor(matches, inFlight);
    caller.abort();
    await expect(cancelled).rejects.toThrow();
    slot.publish(fresh.frame, fresh.release);
    const result = await remaining;
    expect(result?.frame).toBe(fresh.frame);
    await result?.release();
    const unavailable = slot.waitFor((frame) => frame === stale.frame, inFlight);
    preparing.resolve();
    await expect(unavailable).resolves.toBeUndefined();
    const alreadyPublished = await slot.waitFor(matches, () => undefined);
    expect(alreadyPublished?.frame).toBe(fresh.frame);
    await alreadyPublished?.release();
    await slot.settle();
    expect(stale.release).toHaveBeenCalledOnce();
  });

  it("lets an aborted caller leave while its asynchronous check still owns the frame", async () => {
    const slot =
      createConversationKnowledgeCheckpointFrameSlot<ReturnType<typeof fixture>["frame"]>();
    const original = fixture();
    const entered = createDeferredCore();
    const finish = Promise.withResolvers<boolean>();
    const caller = new AbortController();
    const reason = new Error("Synthetic caller stopped");
    slot.publish(original.frame, original.release);
    const waiting = slot.waitFor(
      () => {
        entered.resolve();
        return finish.promise;
      },
      () => undefined,
      caller.signal,
    );
    const outcome = waiting.then(
      () => "unexpected frame",
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      caller.abort(reason);
      slot.clear();
      const nextTick = new Promise((resolve) => {
        setImmediate(() => resolve("still waiting"));
      });
      expect(await Promise.race([outcome, nextTick])).toBe(reason);
      expect(original.release).not.toHaveBeenCalled();
    } finally {
      finish.resolve(true);
      await outcome;
      await slot.settle(true);
    }
    expect(original.release).toHaveBeenCalledOnce();
  });

  it("keeps custody during asynchronous coverage and selects the newer publication", async () => {
    const slot =
      createConversationKnowledgeCheckpointFrameSlot<ReturnType<typeof fixture>["frame"]>();
    const first = fixture();
    const newer = fixture();
    const preparing = createDeferredCore();
    const proving = createDeferredCore();
    const covered = Promise.withResolvers<boolean>();
    const waiting = slot.waitFor(
      (frame) => {
        if (frame === first.frame) {
          proving.resolve();
          return covered.promise;
        }
        return frame === newer.frame;
      },
      () => preparing.promise,
    );

    slot.publish(first.frame, first.release);
    await proving.promise;
    slot.publish(newer.frame, newer.release);
    await slot.settle();
    expect(first.release).not.toHaveBeenCalled();
    covered.resolve(true);
    preparing.resolve();
    const acquired = await waiting;
    expect(acquired?.frame).toBe(newer.frame);
    expect(first.release).toHaveBeenCalledOnce();
    await acquired?.release();
    slot.clear();
    await slot.settle(true);
  });

  it("joins the last borrower before the root closes its native source reader", async () => {
    const slot =
      createConversationKnowledgeCheckpointFrameSlot<ReturnType<typeof fixture>["frame"]>();
    const source = fixture();
    const entered = createDeferredCore(),
      finish = createDeferredCore();
    source.release.mockImplementation(async () => {
      entered.resolve();
      await finish.promise;
    });
    slot.publish(source.frame, source.release);
    const copy = slot.acquire()!;
    slot.clear();
    const closing = slot.settle(true);
    expect(slot.acquire()).toBeUndefined();
    expect(source.release).not.toHaveBeenCalled();
    const released = copy.release();
    await entered.promise;
    expect(source.frame.release).toHaveBeenCalledOnce();
    finish.resolve();
    await Promise.all([released, closing]);
    expect(source.release).toHaveBeenCalledOnce();
  });

  it("retains failed frame cleanup without releasing underlying grants", async () => {
    const slot =
      createConversationKnowledgeCheckpointFrameSlot<ReturnType<typeof fixture>["frame"]>();
    const source = fixture();
    source.frame.release.mockRejectedValueOnce(new Error("Frame close needs retry"));
    slot.publish(source.frame, source.release);
    slot.clear();
    await expect(slot.settle()).rejects.toThrow("cleanup remains pending");
    expect(source.release).not.toHaveBeenCalled();
    await slot.settle();
    expect(source.frame.release).toHaveBeenCalledTimes(2);
    expect(source.release).toHaveBeenCalledOnce();
  });

  it("retries database cleanup without closing an already released frame again", async () => {
    const slot =
      createConversationKnowledgeCheckpointFrameSlot<ReturnType<typeof fixture>["frame"]>();
    const source = fixture();
    source.release.mockRejectedValueOnce(new Error("Reader close needs retry"));
    slot.publish(source.frame, source.release);
    slot.clear();
    await expect(slot.settle()).rejects.toThrow("cleanup remains pending");
    await slot.settle(true);
    expect(source.frame.release).toHaveBeenCalledOnce();
    expect(source.release).toHaveBeenCalledTimes(2);
  });

  it("finishes a frame wait only for the exhausted snapshot of the current preparation", async () => {
    const slot =
      createConversationKnowledgeCheckpointFrameSlot<ReturnType<typeof fixture>["frame"]>();
    const preparing = createDeferredCore();
    const getPreparation = () => preparing.promise;
    const version = { generation: "root-generation", rawSeq: 11, updatedAt: 42 };
    const exact = slot.waitFor(() => true, getPreparation, undefined, version);
    const newer = slot.waitFor(() => true, getPreparation, undefined, { ...version, rawSeq: 12 });
    const rewritten = slot.waitFor(() => true, getPreparation, undefined, {
      ...version,
      generation: "generation-after-rewrite",
    });
    try {
      slot.noteUnavailable(version, preparing.promise);
      const nextTick = new Promise((resolve) => {
        setImmediate(() => resolve("still waiting"));
      });
      expect(await Promise.race([exact, nextTick])).toBeUndefined();
      expect(await Promise.race([newer, nextTick])).toBe("still waiting");
      expect(await Promise.race([rewritten, nextTick])).toBe("still waiting");
    } finally {
      preparing.resolve();
      await Promise.allSettled([exact, newer, rewritten]);
    }
  });
});
