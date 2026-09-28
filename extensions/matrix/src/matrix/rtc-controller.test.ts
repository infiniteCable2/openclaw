import { EventEmitter } from "node:events";
import { EventType } from "matrix-js-sdk/lib/@types/event.js";
import { ClientEvent } from "matrix-js-sdk/lib/client.js";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { MatrixEvent } from "matrix-js-sdk/lib/models/event.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMeetingRealtimeEngineBindings: vi.fn(() => ({
    platform: {},
    consultAgent: vi.fn(),
  })),
  prepareMeetingAgentRealtimeEngine: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
  startMeetingAgentRealtimeEngine: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
  requestMatrixRtcCredentials: vi.fn(async () => ({
    url: "wss://rtc.example.test",
    token: "test-token",
  })),
  createMatrixRtcMediaTransport: vi.fn(async () => ({
    sendKey: vi.fn(),
    stop: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  })),
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", () => ({
  createMeetingRealtimeEngineBindings: mocks.createMeetingRealtimeEngineBindings,
  prepareMeetingAgentRealtimeEngine: mocks.prepareMeetingAgentRealtimeEngine,
  startMeetingAgentRealtimeEngine: mocks.startMeetingAgentRealtimeEngine,
}));

vi.mock("./rtc-auth.js", () => ({
  requestMatrixRtcCredentials: mocks.requestMatrixRtcCredentials,
}));

vi.mock("./rtc-media-transport.js", () => ({
  createMatrixRtcMediaTransport: mocks.createMatrixRtcMediaTransport,
}));

import { registerMatrixRtcController } from "./rtc-controller.js";
import { createMatrixRtcClientFacade } from "./sdk/matrix-rtc.js";

const roomId = "!owner-room:example.test";
const ownerId = "@owner:example.test";
const selfId = "@nova:example.test";

type TestRtcMode = "compatibility" | "matrix_2_0";

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createHarness(
  mode: TestRtcMode,
  options: {
    emitInitialKeys?: boolean;
    emitInitialRemoteKey?: boolean;
    remoteKeyMemberId?: string;
  } = {},
) {
  const emitter = new EventEmitter();
  const sdkEmitter = new EventEmitter();
  const remoteTransport = {
    type: "livekit",
    livekit_service_url: "https://rtc.example.test",
    ...(mode === "compatibility" ? { livekit_alias: roomId } : {}),
  };
  const remoteMembership = {
    userId: ownerId,
    deviceId: "OWNERDEVICE",
    memberId: "owner-member",
    rtcBackendIdentity: "owner-backend",
    createdTs: vi.fn(() => 1),
    getAbsoluteExpiry: vi.fn(() => (mode === "compatibility" ? Date.now() + 60_000 : undefined)),
    getTransport: vi.fn(() => remoteTransport),
  };
  const session = {
    memberships: [] as Array<typeof remoteMembership>,
    initialMembershipCalculated: new Promise<void>(() => {}),
    slotId: "m.call#ROOM",
    getRtcSlot: vi.fn(() => undefined),
    getOldestMembership: vi.fn(() => remoteMembership),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    reemitEncryptionKeys: vi.fn(),
    leaveRoomSession: vi.fn(async () => true),
    joinRTCSession: vi.fn((ownMembership: Record<string, string>) => {
      if (options.emitInitialKeys === false) {
        return;
      }
      if (options.emitInitialRemoteKey !== false) {
        sdkEmitter.emit(ClientEvent.ReceivedToDeviceMessage, {
          message: {
            type: EventType.CallEncryptionKeysPrefix,
            sender: ownerId,
            content: {
              room_id: roomId,
              keys: { index: 0, key: Buffer.alloc(16, 1).toString("base64") },
              member: {
                claimed_device_id: remoteMembership.deviceId,
                id: options.remoteKeyMemberId ?? remoteMembership.memberId,
              },
              sent_ts: Date.now(),
            },
          },
          encryptionInfo: {
            sender: ownerId,
            senderDevice: remoteMembership.deviceId,
            senderCurve25519KeyBase64: "curve-key",
            senderVerified: false,
          },
        });
      }
      emitter.emit(
        MatrixRTCSessionEvent.EncryptionKeyChanged,
        Uint8Array.from([2]),
        0,
        ownMembership,
        "nova-backend",
      );
    }),
  };
  let roomKnown = false;
  const room = {
    roomId,
    getJoinedMembers: vi.fn(() => [{ userId: ownerId }, { userId: selfId }]),
  };
  const managerEmitter = new EventEmitter();
  const getRoomSession = vi.fn(() => session);
  const sdkClient = {
    on: sdkEmitter.on.bind(sdkEmitter),
    off: sdkEmitter.off.bind(sdkEmitter),
    matrixRTC: {
      on: managerEmitter.on.bind(managerEmitter),
      off: managerEmitter.off.bind(managerEmitter),
      getRoomSession,
    },
    getRoom: vi.fn((candidateRoomId: string) =>
      roomKnown && candidateRoomId === roomId ? room : null,
    ),
    getOpenIdToken: vi.fn(async () => ({ access_token: "openid-token" })),
    _unstable_getRTCTransports: vi.fn(async () => [
      {
        type: "livekit",
        livekit_service_url: "https://rtc.example.test",
      },
    ]),
    getUserId: vi.fn(() => selfId),
    getDeviceId: vi.fn(() => "NOVADEVICE"),
  };
  const matrixRtc = createMatrixRtcClientFacade(sdkClient as never);
  const controller = registerMatrixRtcController({
    client: {
      matrixRtc,
      dms: { isDm: vi.fn(() => true) },
    } as never,
    cfg: {} as never,
    accountConfig: {} as never,
    accountId: "default",
    config: {
      authServiceUrl: "https://rtc.example.test",
      mediaBridgeCommand: "/usr/local/bin/matrix-rtc-bridge",
      transcriptionProvider: "local-stt",
      providers: {},
      toolPolicy: "owner",
      agentThinkingLevel: "off",
      responseStreaming: "sentence",
      waitingAudio: {
        filePath: "/var/lib/openclaw/audio/waiting.wav",
        startDelayMs: 1_200,
        volume: 0.14,
      },
      admissions: [{ roomId, userId: ownerId, agentId: "steffen" }],
    },
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "steffen",
            sessionKey: "agent:steffen:matrix:direct:owner",
            mainSessionKey: "agent:steffen:main",
            matchedBy: "binding.peer",
          })),
        },
      },
    } as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
  const stickyMembershipEvent = (candidateRoomId: string) =>
    new MatrixEvent({
      type: EventType.RTCMembership,
      room_id: candidateRoomId,
      sender: ownerId,
      origin_server_ts: Date.now(),
      content: {},
      msc4354_sticky: { duration_ms: 60_000 },
    });

  return {
    emitRemoteKey(index: number, value: number, memberId = remoteMembership.memberId) {
      sdkEmitter.emit(ClientEvent.ReceivedToDeviceMessage, {
        message: {
          type: EventType.CallEncryptionKeysPrefix,
          sender: ownerId,
          content: {
            room_id: roomId,
            keys: { index, key: Buffer.alloc(16, value).toString("base64") },
            member: { claimed_device_id: remoteMembership.deviceId, id: memberId },
            sent_ts: Date.now(),
          },
        },
        encryptionInfo: {
          sender: ownerId,
          senderDevice: remoteMembership.deviceId,
          senderCurve25519KeyBase64: "curve-key",
          senderVerified: false,
        },
      });
    },
    controller,
    emitter,
    getRoomSession,
    managerEmitter,
    remoteMembership,
    remoteTransport,
    sdkClient,
    sdkEmitter,
    session,
    setRoomKnown(value: boolean) {
      roomKnown = value;
    },
    stickyMembershipEvent,
  };
}

describe("registerMatrixRtcController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    harness.managerEmitter.emit("session_ended", roomId);
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

    expect(harness.getRoomSession).toHaveBeenCalledOnce();
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
    expect(mocks.createMeetingRealtimeEngineBindings).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          realtime: expect.objectContaining({ agentId: "steffen", agentThinkingLevel: "off" }),
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
              volume: 0.14,
            },
          }),
        }),
        ttsContext: {
          agentId: "steffen",
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
