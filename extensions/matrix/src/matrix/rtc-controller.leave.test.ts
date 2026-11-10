import { EventEmitter } from "node:events";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  flushPromises,
  getRtcControllerMocks,
  roomId,
} from "./rtc-controller.test-helpers.js";

const mocks = getRtcControllerMocks();

describe("MatrixRTC leave completion ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds stop callers while retaining one leave and the full lifecycle drain", async () => {
    const harness = createHarness("matrix_2_0");
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    const engine = await mocks.startMeetingAgentRealtimeEngine.mock.results[0]!.value;
    const preparation = await mocks.prepareMeetingAgentRealtimeEngine.mock.results[0]!.value;
    const leave = Promise.withResolvers<boolean>();
    harness.session.leave.mockImplementation(() => leave.promise);
    vi.useFakeTimers();
    try {
      const firstWait = expect(harness.controller.stop()).rejects.toThrow(
        "cleanup is still pending",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await firstWait;
      expect(harness.session.leave).toHaveBeenCalledExactlyOnceWith();
      expect(engine.stop).toHaveBeenCalledOnce();
      expect(preparation.release).not.toHaveBeenCalled();

      let drained = false;
      const fullDrain = harness.controller.stop({ waitForCleanup: true }).then(() => {
        drained = true;
      });
      const secondWait = expect(harness.controller.stop()).rejects.toThrow(
        "cleanup is still pending",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await secondWait;
      expect(drained).toBe(false);
      expect(harness.session.leave).toHaveBeenCalledOnce();

      leave.resolve(true);
      await fullDrain;
      expect(drained).toBe(true);
      await harness.controller.stop();
      expect(harness.session.leave).toHaveBeenCalledOnce();
      expect(engine.stop).toHaveBeenCalledOnce();
      expect(preparation.release).toHaveBeenCalledOnce();
    } finally {
      leave.resolve(true);
      await harness.controller.stop({ waitForCleanup: true });
    }
  });

  it("starts a replacement only after the original leave finishes beyond the caller deadline", async () => {
    const harness = createHarness("matrix_2_0");
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    const leave = Promise.withResolvers<boolean>();
    harness.session.leave.mockImplementation(() => leave.promise);
    const replacementEmitter = new EventEmitter();
    const remote = {
      ...harness.remoteMembership,
      memberId: "replacement-member",
      rtcBackendIdentity: "replacement-remote-backend",
    };
    const replacement = {
      ...harness.session,
      memberships: [remote],
      initialMembershipCalculated: Promise.resolve(),
      on: replacementEmitter.on.bind(replacementEmitter),
      off: replacementEmitter.off.bind(replacementEmitter),
      leave: vi.fn(async () => true),
      join: vi.fn((ownMembership: Record<string, string>) => {
        harness.emitRemoteKey(0, 3, remote.memberId);
        replacementEmitter.emit(
          MatrixRTCSessionEvent.EncryptionKeyChanged,
          Uint8Array.from([2]),
          0,
          ownMembership,
          "replacement-local-backend",
        );
      }),
    };
    vi.useFakeTimers();
    try {
      harness.getRoomSession.mockReturnValue(replacement);
      harness.managerEmitter.emit("session_started", roomId, replacement);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(harness.session.leave).toHaveBeenCalledExactlyOnceWith();
      expect(replacement.join).not.toHaveBeenCalled();
      expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();

      leave.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(replacement.join).toHaveBeenCalledOnce();
      expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledTimes(2);
    } finally {
      leave.resolve(true);
      await harness.controller.stop({ waitForCleanup: true });
    }
  });
});
