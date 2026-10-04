import { afterEach, describe, expect, it, vi } from "vitest";
import { createMeetingInputOnset } from "./realtime-input-onset.js";

describe("meeting input completion reservations", () => {
  afterEach(() => vi.useRealTimers());

  it("expires from original onset, even if duplicated or claimed without an admission result", async () => {
    vi.useFakeTimers();
    const onset = createMeetingInputOnset<string>();
    onset.begin("b", "owner-a");
    const completion = onset.waitForChange(() => true);
    await vi.advanceTimersByTimeAsync(119_000);
    onset.begin("b", "replacement");
    const claim = onset.claim("b");
    expect(claim?.value).toBe("owner-a");
    expect(onset.settle("b")).toBeUndefined();
    expect(onset.hasPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await completion;
    expect(onset.waitForChange(() => true)).toBeUndefined();
    expect(onset.hasPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    claim?.release();
    onset.close();
  });

  it("retains onset ownership after expiry until a late transcript settles it", async () => {
    vi.useFakeTimers();
    const onset = createMeetingInputOnset<string>();
    onset.begin("b", "retired-owner");
    await vi.advanceTimersByTimeAsync(120_000);
    await onset.wait();
    expect(onset.hasPending()).toBe(false);
    onset.begin("b", "replacement-owner");
    const claim = onset.claim("b");
    expect(claim?.value).toBe("retired-owner");
    claim?.release();
    onset.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("scopes completion to its original owner and wakes on abort without consuming input", async () => {
    vi.useFakeTimers();
    const onset = createMeetingInputOnset<string>();
    const controller = new AbortController();
    onset.begin("b", "owner-a");
    expect(onset.waitForChange((owner) => owner === "owner-b")).toBeUndefined();
    const completion = onset.waitForChange((owner) => owner === "owner-a", controller.signal);
    controller.abort();
    await completion;
    expect(onset.hasPending()).toBe(true);
    expect(onset.claim("b")?.value).toBe("owner-a");
    onset.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
