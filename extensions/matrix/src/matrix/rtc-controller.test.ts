import { EventEmitter } from "node:events";
import { EventType } from "matrix-js-sdk/lib/@types/event.js";
import { ClientEvent } from "matrix-js-sdk/lib/client.js";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { RTC_SLOT_ENCRYPTION_PER_MEMBER } from "matrix-js-sdk/lib/matrixrtc/types.js";
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

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("registerMatrixRtcController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts from a membership change even while initial membership remains pending", async () => {
    const emitter = new EventEmitter();
    const remoteMembership = {
      userId: ownerId,
      deviceId: "OWNERDEVICE",
      memberId: "owner-member",
      rtcBackendIdentity: "owner-backend",
      getTransport: vi.fn(() => ({
        type: "livekit",
        livekit_service_url: "https://rtc.example.test",
      })),
    };
    const session = {
      memberships: [] as Array<typeof remoteMembership>,
      // matrix-js-sdk may emit a freshly recalculated sticky membership while
      // its constructor-time calculation is still pending. The event itself is
      // the readiness boundary; waiting for this older promise deadlocks call
      // admission without producing an error.
      initialMembershipCalculated: new Promise<void>(() => {}),
      slotId: "m.call#ROOM",
      getRtcSlot: vi.fn(() => ({
        encryption: { type: RTC_SLOT_ENCRYPTION_PER_MEMBER },
      })),
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
    const stickyMembershipEvent = (candidateRoomId: string) =>
      new MatrixEvent({
        type: EventType.RTCMembership,
        room_id: candidateRoomId,
        sender: ownerId,
        origin_server_ts: Date.now(),
        content: {},
        msc4354_sticky: { duration_ms: 60_000 },
      });

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

    controller.startExisting();
    expect(sdkClient.getRoom).toHaveBeenCalledWith(roomId);
    expect(managerEmitter.listenerCount("session_started")).toBe(1);
    expect(managerEmitter.listenerCount("session_ended")).toBe(1);
    expect(sdkEmitter.listenerCount(ClientEvent.Room)).toBe(1);
    expect(sdkEmitter.listenerCount(ClientEvent.Event)).toBe(1);

    sdkEmitter.emit(ClientEvent.Event, stickyMembershipEvent("!other-room:example.test"));
    expect(sdkClient.getRoom).toHaveBeenCalledTimes(1);

    roomKnown = true;
    session.memberships = [remoteMembership];
    sdkEmitter.emit(ClientEvent.Event, stickyMembershipEvent(roomId));
    await flushPromises();

    expect(getRoomSession).toHaveBeenCalledWith(room);
    expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledOnce();
    expect(mocks.createMatrixRtcMediaTransport).toHaveBeenCalledOnce();
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();

    await controller.stop();
  });
});
