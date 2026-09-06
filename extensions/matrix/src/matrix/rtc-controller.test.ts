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

function createHarness(mode: TestRtcMode) {
  const emitter = new EventEmitter();
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
      emitter.emit(
        MatrixRTCSessionEvent.EncryptionKeyChanged,
        Uint8Array.from([1]),
        0,
        remoteMembership,
        remoteMembership.rtcBackendIdentity,
      );
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
  const sdkEmitter = new EventEmitter();
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
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();

    await harness.controller.stop();
  });

  it("keeps legacy membership, authorization, and transport identity coupled", async () => {
    const harness = createHarness("compatibility");
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
      harness.remoteTransport,
      expect.objectContaining({ unstableSendStickyEvents: false }),
    );
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();

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
