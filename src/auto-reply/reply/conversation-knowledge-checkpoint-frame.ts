import type { PreparedConversationKnowledgeInitialFrame } from "../../config/sessions/session-initial-context-frame.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";

type RetainedFrame<Frame> = {
  frame: Frame;
  release(): Promise<void>;
  borrowers: number;
  retired: boolean;
  frameReleased?: boolean;
  idle: Deferred;
  closing?: Promise<void>;
};

/** A root owns one selectable frame; replacement never releases an in-flight copy's custody. */
export function createConversationKnowledgeCheckpointFrameSlot<
  Frame extends Pick<PreparedConversationKnowledgeInitialFrame, "assertCurrent" | "release"> =
    PreparedConversationKnowledgeInitialFrame,
>() {
  let current: RetainedFrame<Frame> | undefined;
  const retired = new Set<RetainedFrame<Frame>>();
  const retire = (value: RetainedFrame<Frame>) => {
    value.retired = true;
    retired.add(value);
    if (current === value) {
      current = undefined;
    }
  };
  const close = (value: RetainedFrame<Frame>): Promise<void> => {
    if (value.closing) {
      return value.closing;
    }
    const closing = (async () => {
      if (!value.frameReleased) {
        await value.frame.release();
        value.frameReleased = true;
      }
      await value.release();
      retired.delete(value);
    })();
    value.closing = closing;
    void closing.catch(() => {
      // A failed release remains owned and retryable; no live source is forgotten.
      if (value.closing === closing) {
        value.closing = undefined;
      }
    });
    return closing;
  };
  return {
    publish(frame: Frame, release: () => Promise<void>) {
      frame.assertCurrent();
      if (current) {
        retire(current);
      }
      current = { frame, release, borrowers: 0, retired: false, idle: createDeferredCore() };
    },
    acquire() {
      const value = current;
      if (!value) {
        return undefined;
      }
      try {
        value.frame.assertCurrent();
      } catch {
        retire(value);
        return undefined;
      }
      if (value.borrowers++ === 0) {
        value.idle = createDeferredCore();
      }
      let active = true;
      return {
        frame: value.frame,
        async release() {
          if (!active) {
            return;
          }
          active = false;
          if (--value.borrowers === 0) {
            value.idle.resolve();
            if (value.retired) {
              await close(value);
            }
          }
        },
      };
    },
    clear() {
      if (current) {
        retire(current);
      }
    },
    async settle(closing = false) {
      const failures: unknown[] = [];
      // A replacement can retire another frame while this pass awaits a borrower.
      const cleanupSnapshot = Array.from(retired);
      for (const value of cleanupSnapshot) {
        if (closing && value.borrowers > 0) {
          await value.idle.promise;
        }
        if (value.borrowers === 0) {
          try {
            await close(value);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Prepared root frame cleanup remains pending");
      }
    },
  };
}
