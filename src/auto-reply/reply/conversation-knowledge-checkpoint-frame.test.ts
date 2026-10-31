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
});
