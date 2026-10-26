import type { Message, StreamOptions } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import {
  attachInternalModelContextReceiver,
  publishInternalModelContext,
} from "./internal-hooks.js";

const messages: Message[] = [{ role: "user", content: "Prepared context", timestamp: 1 }];
const callback = (): NonNullable<StreamOptions["onActiveResponse"]> => () => undefined;

describe("private final model context handoff", () => {
  it("only reaches the exact request callback and preserves receiver admission", () => {
    const request = callback();
    const otherRequest = callback();
    const receive = vi.fn(() => true);
    const release = attachInternalModelContextReceiver(request, receive);
    try {
      expect(publishInternalModelContext(undefined, messages)).toBe(false);
      expect(publishInternalModelContext(otherRequest, messages)).toBe(false);
      expect(publishInternalModelContext(request, messages)).toBe(true);
      expect(receive).toHaveBeenCalledExactlyOnceWith(messages);
    } finally {
      release();
    }
    expect(publishInternalModelContext(request, messages)).toBe(false);
    expect(receive).toHaveBeenCalledOnce();
  });

  it("cannot replace another request or reopen a released response", () => {
    const first = callback();
    const second = callback();
    const receiveFirst = vi.fn(() => true);
    const receiveSecond = vi.fn(() => true);
    const releaseFirst = attachInternalModelContextReceiver(first, receiveFirst);
    const releaseSecond = attachInternalModelContextReceiver(second, receiveSecond);
    releaseFirst();
    releaseFirst();
    try {
      expect(publishInternalModelContext(first, messages)).toBe(false);
      expect(publishInternalModelContext(second, messages)).toBe(true);
      expect(receiveFirst).not.toHaveBeenCalled();
      expect(receiveSecond).toHaveBeenCalledOnce();
    } finally {
      releaseSecond();
    }
    expect(publishInternalModelContext(second, messages)).toBe(false);
  });

  it("retains a replacement receiver when an older binding is released", () => {
    const request = callback();
    const releaseOld = attachInternalModelContextReceiver(request, () => true);
    const reject = vi.fn(() => false);
    const releaseCurrent = attachInternalModelContextReceiver(request, reject);
    releaseOld();
    try {
      expect(publishInternalModelContext(request, messages)).toBe(false);
      expect(reject).toHaveBeenCalledOnce();
    } finally {
      releaseCurrent();
    }
    expect(publishInternalModelContext(request, messages)).toBe(false);
    expect(reject).toHaveBeenCalledOnce();
  });
});
