import { createClient, Room, type EmptyObject } from "matrix-js-sdk";
import { MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopCall, type ActiveCall } from "./rtc-call-lifecycle.js";

describe("MatrixRTC native leave contract", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the SDK leave pending until its original membership removal completes", async () => {
    vi.useFakeTimers();
    const userId = "@caller:example.test";
    const client = createClient({
      baseUrl: "https://matrix.example.test",
      userId,
      deviceId: "TESTDEVICE",
    });
    vi.spyOn(client, "_unstable_sendDelayedStateEvent").mockResolvedValue({
      delay_id: "leave-event",
    });
    vi.spyOn(client, "_unstable_restartScheduledDelayedEvent").mockResolvedValue({});
    const sendMembership = vi
      .spyOn(client, "sendStateEvent")
      .mockResolvedValue({ event_id: "$joined" });
    const removal = Promise.withResolvers<EmptyObject>();
    const sendRemoval = vi
      .spyOn(client, "_unstable_sendScheduledDelayedEvent")
      .mockImplementation(() => removal.promise);
    const session = new MatrixRTCSession(client, new Room("!call:example.test", client, userId), {
      application: "m.call",
      id: "ROOM",
    });
    await session.initialMembershipCalculated;
    session.join(
      { userId, deviceId: "TESTDEVICE", memberId: "test-member" },
      [{ type: "livekit", livekit_service_url: "https://rtc.example.test" }],
      { manageMediaKeys: false },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMembership).toHaveBeenCalledOnce();
    expect(session.isJoined()).toBe(true);
    const leave = vi.spyOn(session, "leave");
    const call: ActiveCall = {
      session,
      abort: new AbortController(),
      joined: true,
      stopping: true,
      disposeListeners: vi.fn(),
    };
    let settled = false;
    const cleanup = stopCall(call).finally(() => {
      settled = true;
    });
    // Observe rejection before advancing timers so the old timed-out SDK path
    // fails the assertion rather than creating an unhandled rejection.
    const result = cleanup.then(
      () => ({ status: "fulfilled" }),
      (error: unknown) => ({ status: "rejected", error }),
    );
    try {
      await vi.advanceTimersByTimeAsync(5_001);
      expect(sendRemoval).toHaveBeenCalledExactlyOnceWith("leave-event");
      expect(session.isJoined()).toBe(false);
      expect(settled).toBe(false);
      expect(call.joined).toBe(true);
      expect(leave).toHaveBeenCalledExactlyOnceWith();

      removal.resolve({});
      await expect(result).resolves.toEqual({ status: "fulfilled" });
      expect(call.joined).toBe(false);
      await stopCall(call);
      expect(leave).toHaveBeenCalledOnce();
    } finally {
      removal.resolve({});
      await result;
      await session.stop();
    }
  });
});
