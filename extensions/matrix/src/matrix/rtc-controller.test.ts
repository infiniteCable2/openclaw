import { EventEmitter } from "node:events";
import { EventType } from "matrix-js-sdk/lib/@types/event.js";
import { ClientEvent } from "matrix-js-sdk/lib/client.js";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  flushPromises,
  getRtcControllerMocks,
  ownerId,
  roomId,
} from "./rtc-controller.test-helpers.js";

const mocks = getRtcControllerMocks();

describe("registerMatrixRtcController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([undefined, false, true])(
    "uses only the admitted agent's central video opt-in (%s)",
    async (video) => {
      const harness = createHarness("matrix_2_0", { video });
      harness.setRoomKnown(true);
      harness.session.memberships = [harness.remoteMembership];
      harness.managerEmitter.emit("session_started", roomId, harness.session);
      await flushPromises();
      const transport = mocks.createMatrixRtcMediaTransport.mock.calls[0]?.[0];
      const engine = mocks.startMeetingAgentRealtimeEngine.mock.calls[0]?.[0];
      expect(transport).toBeDefined();
      expect(engine).toBeDefined();
      expect(transport?.video?.enabled === true).toBe(video === true);
      expect(engine?.config.realtime.video).toEqual(transport?.video);
      await harness.controller.stop();
    },
  );

  it("prepares an agent-authored greeting before joining and plays it in the same call session", async () => {
    const harness = createHarness("matrix_2_0", { greeting: true });
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(mocks.prepareMeetingAgentGreeting).toHaveBeenCalledOnce();
    expect(mocks.prepareMeetingAgentGreeting.mock.invocationCallOrder[0]).toBeLessThan(
      harness.session.joinRTCSession.mock.invocationCallOrder[0]!,
    );
    expect(mocks.createMatrixRtcMediaTransport).toHaveBeenCalledWith(
      expect.objectContaining({ requireRemoteAudioReady: true }),
    );
    const greeting = mocks.prepareMeetingAgentGreeting.mock.results[0]!.value;
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledWith(
      expect.objectContaining({ initialGreeting: await greeting }),
    );
    const preparedSessionId = mocks.prepareMeetingAgentGreeting.mock.calls[0]![0].meetingSessionId;
    expect(mocks.startMeetingAgentRealtimeEngine.mock.calls[0]![0].meetingSessionId).toBe(
      preparedSessionId,
    );
    await harness.controller.stop();
  });

  it("does not join when the admitted caller leaves during greeting preparation", async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof mocks.prepareMeetingAgentGreeting>>>();
    mocks.prepareMeetingAgentGreeting.mockReturnValueOnce(pending.promise);
    const harness = createHarness("matrix_2_0", { greeting: true });
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(mocks.prepareMeetingAgentGreeting).toHaveBeenCalledOnce();
    harness.session.memberships = [];
    pending.resolve({ text: "Hello, caller.", audio: Buffer.from([1, 0]) });
    await flushPromises();
    expect(harness.session.joinRTCSession).not.toHaveBeenCalled();
    await harness.controller.stop();
  });

  it("accepts SDK membership renewal during greeting and while the call is active", async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof mocks.prepareMeetingAgentGreeting>>>();
    mocks.prepareMeetingAgentGreeting.mockReturnValueOnce(pending.promise);
    const harness = createHarness("matrix_2_0", { greeting: true });
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(mocks.prepareMeetingAgentGreeting).toHaveBeenCalledOnce();
    expect(harness.session.joinRTCSession).not.toHaveBeenCalled();
    const renewed = { ...harness.remoteMembership, createdTs: vi.fn(() => 2) };
    harness.session.memberships = [renewed];
    pending.resolve({ text: "Hello, caller.", audio: Buffer.from([1, 0]) });
    await flushPromises();
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
    const engine = await mocks.startMeetingAgentRealtimeEngine.mock.results[0]!.value;
    harness.session.memberships = [{ ...renewed, createdTs: vi.fn(() => 3) }];
    harness.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
    await flushPromises();
    expect(engine.stop).not.toHaveBeenCalled();
    expect(harness.session.leaveRoomSession).not.toHaveBeenCalled();
    await harness.controller.stop();
  });

  it.each(["engine-stop", "membership-leave"] as const)(
    "replaces an active SDK session only after deferred %s and ignores its stale callbacks",
    async (phase) => {
      const harness = createHarness("matrix_2_0");
      const release = Promise.withResolvers<void>();
      try {
        harness.setRoomKnown(true);
        harness.session.memberships = [harness.remoteMembership];
        harness.managerEmitter.emit("session_started", roomId, harness.session);
        await flushPromises();
        const engine = await mocks.startMeetingAgentRealtimeEngine.mock.results[0]!.value;
        const preparation = await mocks.prepareMeetingAgentRealtimeEngine.mock.results[0]!.value;
        const callbacks = harness.emitter.listeners(MatrixRTCSessionEvent.MembershipsChanged);
        const leave = harness.session.leaveRoomSession;
        if (phase === "engine-stop") {
          engine.stop.mockImplementationOnce(() => release.promise.then(() => undefined));
        } else {
          leave.mockImplementationOnce(async () => {
            await release.promise;
            return true;
          });
        }
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
          getOldestMembership: vi.fn(() => remote),
          on: replacementEmitter.on.bind(replacementEmitter),
          off: replacementEmitter.off.bind(replacementEmitter),
          leaveRoomSession: vi.fn(async () => true),
          joinRTCSession: vi.fn((ownMembership: Record<string, string>) => {
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
        harness.getRoomSession.mockReturnValue(replacement);
        harness.managerEmitter.emit("session_started", roomId, replacement);
        await flushPromises();
        expect(engine.stop).toHaveBeenCalledOnce();
        expect(leave).toHaveBeenCalledTimes(phase === "engine-stop" ? 0 : 1);
        expect(preparation.release).not.toHaveBeenCalled();
        expect(mocks.prepareMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
        expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
        release.resolve();
        await flushPromises();
        expect(preparation.release).toHaveBeenCalledOnce();
        expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledTimes(2);
        const successor = await mocks.startMeetingAgentRealtimeEngine.mock.results[1]!.value;
        expect(preparation.release.mock.invocationCallOrder[0]!).toBeLessThan(
          mocks.startMeetingAgentRealtimeEngine.mock.invocationCallOrder[1]!,
        );
        expect(harness.emitter.listenerCount(MatrixRTCSessionEvent.MembershipsChanged)).toBe(0);
        harness.session.memberships = [];
        harness.completeInitialMembership();
        harness.managerEmitter.emit("session_ended", roomId, harness.session);
        harness.managerEmitter.emit("session_started", roomId, harness.session);
        for (const callback of callbacks) {
          callback();
        }
        harness.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
        await flushPromises();
        expect(successor.stop).not.toHaveBeenCalled();
        expect(replacement.leaveRoomSession).not.toHaveBeenCalled();
        expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledTimes(2);
        harness.managerEmitter.emit("session_ended", roomId, replacement);
        await flushPromises();
        expect(successor.stop).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await harness.controller.stop();
      }
    },
  );

  it.each(["userId", "deviceId", "memberId", "rtcBackendIdentity"] as const)(
    "ends the original call when the admitted membership changes %s",
    async (field) => {
      const harness = createHarness("matrix_2_0");
      harness.setRoomKnown(true);
      harness.session.memberships = [harness.remoteMembership];
      harness.managerEmitter.emit("session_started", roomId, harness.session);
      await flushPromises();
      const engine = await mocks.startMeetingAgentRealtimeEngine.mock.results[0]!.value;
      harness.session.memberships = [{ ...harness.remoteMembership, [field]: "changed-identity" }];
      harness.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
      await flushPromises();
      expect(engine.stop).toHaveBeenCalledOnce();
      expect(harness.session.leaveRoomSession).toHaveBeenCalledOnce();
      expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
      await harness.controller.stop();
    },
  );

  it.each(["slot", "local-device"] as const)("ends a call after its %s changes", async (change) => {
    const harness = createHarness("matrix_2_0");
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    const engine = await mocks.startMeetingAgentRealtimeEngine.mock.results[0]!.value;
    if (change === "slot") {
      harness.session.isSlotClosed.mockReturnValue(true);
    } else {
      harness.sdkClient.getDeviceId.mockReturnValue("REPLACEMENTDEVICE");
    }
    harness.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
    await flushPromises();
    expect(engine.stop).toHaveBeenCalledOnce();
    await harness.controller.stop();
  });

  it("does not join after its SDK session is replaced during greeting preparation", async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof mocks.prepareMeetingAgentGreeting>>>();
    mocks.prepareMeetingAgentGreeting.mockReturnValueOnce(pending.promise);
    const harness = createHarness("matrix_2_0", { greeting: true });
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    const replacement = { ...harness.session, memberships: [] };
    harness.getRoomSession.mockReturnValue(replacement);
    harness.managerEmitter.emit("session_started", roomId, replacement);
    pending.resolve({ text: "Hello, caller.", audio: Buffer.from([1, 0]) });
    await flushPromises();
    expect(harness.session.joinRTCSession).not.toHaveBeenCalled();
    expect(mocks.requestMatrixRtcCredentials).not.toHaveBeenCalled();
    expect(mocks.startMeetingAgentRealtimeEngine).not.toHaveBeenCalled();
    await harness.controller.stop();
  });

  it("rechecks membership after OpenID acquisition before requesting RTC credentials", async () => {
    const harness = createHarness("matrix_2_0");
    const openId =
      Promise.withResolvers<Awaited<ReturnType<typeof harness.sdkClient.getOpenIdToken>>>();
    harness.sdkClient.getOpenIdToken.mockReturnValueOnce(openId.promise);
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(harness.sdkClient.getOpenIdToken).toHaveBeenCalledOnce();
    // No event: the per-call membership listener is not installed until credentials exist.
    harness.session.memberships = [{ ...harness.remoteMembership, deviceId: "REPLACEMENTDEVICE" }];
    openId.resolve({ access_token: "openid-token" });
    await flushPromises();
    expect(mocks.requestMatrixRtcCredentials).not.toHaveBeenCalled();
    expect(harness.session.joinRTCSession).not.toHaveBeenCalled();
    await harness.controller.stop();
  });

  it.each([
    [undefined, false],
    ["continue", true],
    ["reject", false],
  ] as const)("handles greeting preparation failure with %s policy", async (onFailure, joins) => {
    mocks.prepareMeetingAgentGreeting.mockRejectedValueOnce(
      new Error("synthetic preparation error"),
    );
    const harness = createHarness("matrix_2_0", {
      greeting: true,
      greetingOnFailure: onFailure,
    });
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(mocks.prepareMeetingAgentGreeting).toHaveBeenCalledOnce();
    expect(harness.session.joinRTCSession.mock.calls.length > 0).toBe(joins);
    await harness.controller.stop();
  });

  it("cannot continue admission or release readiness while greeting cleanup remains failed", async () => {
    let cleanupFails = true;
    const greetingRelease = vi.fn(async () => {
      if (cleanupFails) {
        throw new Error("synthetic greeting hold cleanup failed");
      }
    });
    const readinessRelease = vi.fn(async () => undefined);
    mocks.prepareMeetingAgentRealtimeEngine.mockResolvedValueOnce({ release: readinessRelease });
    mocks.prepareMeetingAgentGreeting.mockImplementationOnce(async (params) => {
      params.onPreparation?.({ release: greetingRelease });
      throw new Error("synthetic greeting generation failed");
    });
    const harness = createHarness("matrix_2_0", { greeting: true, greetingOnFailure: "continue" });
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(greetingRelease).toHaveBeenCalledTimes(2);
    expect(harness.session.joinRTCSession).not.toHaveBeenCalled();
    expect(mocks.requestMatrixRtcCredentials).not.toHaveBeenCalled();
    expect(mocks.startMeetingAgentRealtimeEngine).not.toHaveBeenCalled();
    expect(readinessRelease).not.toHaveBeenCalled();
    // Neither a repeated membership signal nor a failed stop can discard its owner.
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(mocks.prepareMeetingAgentGreeting).toHaveBeenCalledOnce();
    await expect(harness.controller.stop()).rejects.toThrow("retry controller.stop()");
    cleanupFails = false;
    await harness.controller.stop();
    await harness.controller.stop();
    expect(readinessRelease).toHaveBeenCalledOnce();
    expect(greetingRelease.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      readinessRelease.mock.invocationCallOrder[0]!,
    );
  });

  it("retains and releases readiness acquired after cancellation without joining", async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof mocks.prepareMeetingAgentRealtimeEngine>>>();
    mocks.prepareMeetingAgentRealtimeEngine.mockReturnValueOnce(pending.promise);
    const release = vi.fn(async () => undefined);
    const harness = createHarness("matrix_2_0");
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(mocks.prepareMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
    const stopped = vi.fn();
    const stopping = harness.controller.stop().then(stopped);
    await flushPromises();
    expect(stopped).not.toHaveBeenCalled();
    pending.resolve({ release });
    await stopping;
    expect(release).toHaveBeenCalledOnce();
    expect(harness.session.joinRTCSession).not.toHaveBeenCalled();
    expect(mocks.requestMatrixRtcCredentials).not.toHaveBeenCalled();
  });

  it("keeps failed-start cleanup owned until an explicit stop retry releases it", async () => {
    const cleanupFailure = new Error("synthetic lease release failure");
    const release = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(cleanupFailure)
      .mockRejectedValueOnce(cleanupFailure);
    mocks.prepareMeetingAgentRealtimeEngine.mockImplementationOnce(async (params) => {
      params.onPreparation?.({ release });
      throw new Error("synthetic readiness failure");
    });
    const harness = createHarness("matrix_2_0");
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(release).toHaveBeenCalledOnce();
    // Replacement admission cannot discard a still-owned failed cleanup lease.
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(mocks.prepareMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
    await expect(harness.controller.stop()).rejects.toThrow("retry controller.stop()");
    expect(release).toHaveBeenCalledTimes(2);
    await harness.controller.stop();
    await harness.controller.stop();
    expect(release).toHaveBeenCalledTimes(3);
    expect(harness.session.joinRTCSession).not.toHaveBeenCalled();
    expect(mocks.requestMatrixRtcCredentials).not.toHaveBeenCalled();
  });

  it("disposes a transport arriving after hangup before releasing readiness", async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof mocks.createMatrixRtcMediaTransport>>>();
    mocks.createMatrixRtcMediaTransport.mockReturnValueOnce(pending.promise);
    const release = vi.fn(async () => undefined);
    mocks.prepareMeetingAgentRealtimeEngine.mockResolvedValueOnce({ release });
    const transport = {
      sendKey: vi.fn(),
      stop: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const harness = createHarness("matrix_2_0");
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(mocks.createMatrixRtcMediaTransport).toHaveBeenCalledOnce();
    harness.managerEmitter.emit("session_ended", roomId, harness.session);
    await flushPromises();
    expect(release).not.toHaveBeenCalled();
    pending.resolve(transport);
    await harness.controller.stop();
    expect(transport.stop).toHaveBeenCalledOnce();
    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.startMeetingAgentRealtimeEngine).not.toHaveBeenCalled();
    expect(harness.session.leaveRoomSession).toHaveBeenCalledOnce();
  });

  it("stops an engine arriving after cancellation through its adopted transport owner", async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof mocks.startMeetingAgentRealtimeEngine>>>();
    mocks.startMeetingAgentRealtimeEngine.mockReturnValueOnce(pending.promise);
    const stop = vi.fn(async () => undefined);
    const harness = createHarness("matrix_2_0");
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
    const transport = await mocks.createMatrixRtcMediaTransport.mock.results[0]!.value;
    const stopping = harness.controller.stop();
    await flushPromises();
    expect(transport.stop).not.toHaveBeenCalled();
    pending.resolve({ stop });
    await stopping;
    expect(stop).toHaveBeenCalledOnce();
    expect(transport.stop).not.toHaveBeenCalled();
    expect(transport.dispose).not.toHaveBeenCalled();
    expect(harness.session.leaveRoomSession).toHaveBeenCalledOnce();
  });

  it("reconciles keys rotated during startup and forwards only admitted later rotations", async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof mocks.createMatrixRtcMediaTransport>>>();
    mocks.createMatrixRtcMediaTransport.mockReturnValueOnce(pending.promise);
    const transport = {
      sendKey: vi.fn(),
      stop: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const harness = createHarness("matrix_2_0");
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(mocks.createMatrixRtcMediaTransport).toHaveBeenCalledOnce();
    harness.emitRemoteKey(0, 8);
    pending.resolve(transport);
    await flushPromises();
    expect(transport.sendKey).toHaveBeenCalledExactlyOnceWith({
      participantIdentity: "owner-backend",
      index: 0,
      key: Uint8Array.from(Buffer.alloc(16, 8)),
    });
    harness.emitRemoteKey(1, 9);
    harness.emitRemoteKey(2, 10, "another-member");
    expect(transport.sendKey).toHaveBeenCalledTimes(2);
    expect(transport.sendKey).toHaveBeenLastCalledWith({
      participantIdentity: "owner-backend",
      index: 1,
      key: Uint8Array.from(Buffer.alloc(16, 9)),
    });
    await harness.controller.stop();
    harness.emitRemoteKey(3, 11);
    expect(transport.sendKey).toHaveBeenCalledTimes(2);
  });

  it("starts from a membership change even while initial membership remains pending", async () => {
    const harness = createHarness("matrix_2_0");

    harness.controller.startExisting();
    expect(harness.sdkClient.getRoom).toHaveBeenCalledWith(roomId);
    expect(harness.managerEmitter.listenerCount("session_started")).toBe(1);
    expect(harness.managerEmitter.listenerCount("session_ended")).toBe(1);
    expect(harness.sdkEmitter.listenerCount(ClientEvent.Room)).toBe(1);
    expect(harness.sdkEmitter.listenerCount(ClientEvent.Event)).toBe(1);

    harness.sdkEmitter.emit(
      ClientEvent.Event,
      harness.stickyMembershipEvent("!other-room:example.test"),
    );
    expect(harness.sdkClient.getRoom).toHaveBeenCalledTimes(1);

    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.sdkEmitter.emit(ClientEvent.Event, harness.stickyMembershipEvent(roomId));
    await flushPromises();

    expect(harness.getRoomSession).toHaveBeenCalledWith(expect.objectContaining({ roomId }));
    expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledOnce();
    expect(mocks.prepareMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
    expect(mocks.prepareMeetingAgentRealtimeEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          realtime: expect.objectContaining({
            responseStreaming: "sentence",
            waitingAudio: {
              filePath: "/var/lib/openclaw/audio/waiting.wav",
              startDelayMs: 1_200,
              resumeDelayMs: 800,
              volume: 0.14,
            },
          }),
        }),
      }),
    );
    expect(mocks.prepareMeetingAgentRealtimeEngine.mock.invocationCallOrder[0]).toBeLessThan(
      harness.session.joinRTCSession.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "matrix_2_0" }),
    );
    expect(harness.session.joinRTCSession).toHaveBeenCalledWith(
      expect.any(Object),
      [expect.not.objectContaining({ livekit_alias: expect.anything() })],
      expect.not.objectContaining({ livekit_alias: expect.anything() }),
      expect.objectContaining({ unstableSendStickyEvents: true }),
    );
    expect(mocks.createMatrixRtcMediaTransport).toHaveBeenCalledOnce();
    expect(mocks.createMeetingRealtimeEngineBindingsV2).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: ownerId,
        config: expect.objectContaining({
          realtime: expect.objectContaining({
            agentId: "example_owner",
            agentThinkingLevel: "off",
            speakCommentary: true,
          }),
        }),
      }),
    );
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          realtime: expect.objectContaining({
            responseStreaming: "sentence",
            waitingAudio: {
              filePath: "/var/lib/openclaw/audio/waiting.wav",
              startDelayMs: 1_200,
              resumeDelayMs: 800,
              volume: 0.14,
            },
          }),
        }),
        ttsContext: {
          agentId: "example_owner",
          channelId: "matrix",
          accountId: "default",
        },
      }),
    );

    await harness.controller.stop();
  });

  it("keeps legacy membership, authorization, and transport identity coupled", async () => {
    const harness = createHarness("compatibility", {
      // Element Call uses its transient own-membership UUID in the key
      // payload while legacy m.call.member publishes user:device.
      remoteKeyMemberId: "element-call-transient-member",
    });
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];

    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();

    expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "compatibility" }),
    );
    expect(harness.session.joinRTCSession).toHaveBeenCalledWith(
      expect.any(Object),
      [harness.remoteTransport],
      undefined,
      expect.objectContaining({ unstableSendStickyEvents: false }),
    );
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();

    await harness.controller.stop();
  });

  it("uses an encrypted RTC key received before the per-call SDK listener exists", async () => {
    const harness = createHarness("compatibility", { emitInitialRemoteKey: false });
    harness.sdkEmitter.emit(ClientEvent.ReceivedToDeviceMessage, {
      message: {
        type: EventType.CallEncryptionKeysPrefix,
        sender: ownerId,
        content: {
          room_id: roomId,
          keys: { index: 0, key: Buffer.alloc(16, 7).toString("base64") },
          member: {
            claimed_device_id: "OWNERDEVICE",
            id: "element-call-transient-member",
          },
          sent_ts: Date.now(),
        },
      },
      encryptionInfo: {
        sender: ownerId,
        senderDevice: "OWNERDEVICE",
        senderCurve25519KeyBase64: "curve-key",
        senderVerified: false,
      },
    });
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];

    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();

    expect(mocks.createMatrixRtcMediaTransport).toHaveBeenCalledOnce();
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();

    await harness.controller.stop();
  });

  it("requires an exact member ID for a pre-join Matrix 2.0 media key", async () => {
    const harness = createHarness("matrix_2_0", { emitInitialRemoteKey: false });
    harness.sdkEmitter.emit(ClientEvent.ReceivedToDeviceMessage, {
      message: {
        type: EventType.CallEncryptionKeysPrefix,
        sender: ownerId,
        content: {
          room_id: roomId,
          keys: { index: 0, key: Buffer.alloc(16, 7).toString("base64") },
          member: { claimed_device_id: "OWNERDEVICE", id: "wrong-member" },
          sent_ts: Date.now(),
        },
      },
      encryptionInfo: {
        sender: ownerId,
        senderDevice: "OWNERDEVICE",
        senderCurve25519KeyBase64: "curve-key",
        senderVerified: false,
      },
    });
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];

    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();

    expect(mocks.createMatrixRtcMediaTransport).not.toHaveBeenCalled();
    expect(mocks.startMeetingAgentRealtimeEngine).not.toHaveBeenCalled();

    await harness.controller.stop();
  });

  it("does not restart a call from its own membership changes during cleanup", async () => {
    const harness = createHarness("compatibility");
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledOnce();

    const leave = Promise.withResolvers<boolean>();
    harness.session.leaveRoomSession.mockImplementation(() => {
      harness.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
      return leave.promise;
    });
    harness.managerEmitter.emit("session_ended", roomId, harness.session);
    await flushPromises();

    expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledOnce();
    leave.resolve(true);
    await flushPromises();
    expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledOnce();

    await harness.controller.stop();
  });

  it.each(["unconfirmed-or-timed-out", "rejected"] as const)(
    "keeps a %s membership leave owned without repeating completed media cleanup",
    async (failureMode) => {
      const release = vi.fn(async () => undefined);
      mocks.prepareMeetingAgentRealtimeEngine.mockResolvedValueOnce({ release });
      const harness = createHarness("matrix_2_0");
      harness.setRoomKnown(true);
      harness.session.memberships = [harness.remoteMembership];
      harness.managerEmitter.emit("session_started", roomId, harness.session);
      await flushPromises();
      const engine = await mocks.startMeetingAgentRealtimeEngine.mock.results[0]!.value;
      harness.session.leaveRoomSession.mockImplementation(async () => {
        if (failureMode === "rejected") {
          throw new Error("synthetic membership leave failure");
        }
        return false;
      });

      harness.managerEmitter.emit("session_ended", roomId, harness.session);
      await flushPromises();
      expect(harness.session.leaveRoomSession).toHaveBeenCalledWith(5_000);
      expect(engine.stop).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      // The still-owned membership blocks replacement admission even though its
      // independent media resources have already been released successfully.
      harness.managerEmitter.emit("session_started", roomId, harness.session);
      await flushPromises();
      expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();
      await expect(harness.controller.stop()).rejects.toThrow("retry controller.stop()");
      expect(harness.session.leaveRoomSession).toHaveBeenCalledTimes(2);
      expect(engine.stop).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();

      harness.session.leaveRoomSession.mockResolvedValue(true);
      await harness.controller.stop();
      await harness.controller.stop();
      expect(harness.session.leaveRoomSession).toHaveBeenCalledTimes(3);
      expect(engine.stop).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("preserves media and membership failures while retaining readiness for a stop retry", async () => {
    const mediaFailure = new Error("synthetic media stop failure");
    const membershipFailure = new Error("synthetic membership leave failure");
    const release = vi.fn(async () => undefined);
    mocks.prepareMeetingAgentRealtimeEngine.mockResolvedValueOnce({ release });
    const harness = createHarness("matrix_2_0");
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();
    const engine = await mocks.startMeetingAgentRealtimeEngine.mock.results[0]!.value;
    engine.stop.mockRejectedValueOnce(mediaFailure);
    harness.session.leaveRoomSession.mockRejectedValueOnce(membershipFailure);

    await expect(harness.controller.stop()).rejects.toMatchObject({
      errors: [expect.objectContaining({ errors: [mediaFailure, membershipFailure] })],
    });
    expect(release).not.toHaveBeenCalled();
    await harness.controller.stop();
    expect(engine.stop).toHaveBeenCalledTimes(2);
    expect(harness.session.leaveRoomSession).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not retry a failed remote call membership until that membership changes", async () => {
    vi.useFakeTimers();
    const harness = createHarness("compatibility", { emitInitialKeys: false });
    const left = Promise.withResolvers<void>();
    harness.session.leaveRoomSession.mockImplementation(async () => {
      left.resolve();
      return true;
    });
    try {
      harness.setRoomKnown(true);
      harness.session.memberships = [harness.remoteMembership];
      harness.managerEmitter.emit("session_started", roomId, harness.session);
      await vi.advanceTimersByTimeAsync(15_100);
      // The abort-aware node timer is real; await the owner-observed leave after
      // advancing the deadline, rather than assuming a fake clock drains it.
      await left.promise;

      expect(harness.session.leaveRoomSession).toHaveBeenCalledOnce();
      expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledOnce();

      harness.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledOnce();

      harness.remoteMembership.createdTs.mockReturnValue(2);
      harness.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledTimes(2);
    } finally {
      await harness.controller.stop();
      vi.useRealTimers();
    }
  });

  it("ends a call if its admitted membership changes protocol mode", async () => {
    const harness = createHarness("compatibility");
    harness.setRoomKnown(true);
    harness.session.memberships = [harness.remoteMembership];
    harness.managerEmitter.emit("session_started", roomId, harness.session);
    await flushPromises();

    harness.remoteMembership.getAbsoluteExpiry.mockReturnValue(undefined);
    harness.emitter.emit(MatrixRTCSessionEvent.MembershipsChanged);
    await flushPromises();

    expect(harness.session.leaveRoomSession).toHaveBeenCalledOnce();
    expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledOnce();

    await harness.controller.stop();
  });
});
