import { EventEmitter } from "node:events";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { RTC_SLOT_ENCRYPTION_PER_MEMBER } from "matrix-js-sdk/lib/matrixrtc/types.js";
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
    let sessionStarted: ((roomId: string, session: unknown) => void) | undefined;
    let sessionEnded: ((roomId: string, session: unknown) => void) | undefined;
    let roomAvailable: ((roomId: string) => void) | undefined;
    let rtcMembershipEvent: ((roomId: string) => void) | undefined;
    let roomKnown = false;
    const matrixRtc = {
      onSessionStarted: vi.fn((listener) => {
        sessionStarted = listener;
        return vi.fn();
      }),
      onSessionEnded: vi.fn((listener) => {
        sessionEnded = listener;
        return vi.fn();
      }),
      onRoomAvailable: vi.fn((listener) => {
        roomAvailable = listener;
        return vi.fn();
      }),
      onRtcMembershipEvent: vi.fn((listener) => {
        rtcMembershipEvent = listener;
        return vi.fn();
      }),
      getRoomSession: vi.fn(() => (roomKnown ? session : undefined)),
      getJoinedUserIds: vi.fn(() => [ownerId, selfId]),
      getOpenIdToken: vi.fn(async () => ({ access_token: "openid-token" })),
      getPreferredLivekitTransport: vi.fn(async () => ({
        type: "livekit",
        livekit_service_url: "https://rtc.example.test",
      })),
      getSelfIdentity: vi.fn(() => ({ userId: selfId, deviceId: "NOVADEVICE" })),
    };
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
    expect(matrixRtc.getRoomSession).toHaveBeenCalledWith(roomId);
    expect(sessionStarted).toBeTypeOf("function");
    expect(sessionEnded).toBeTypeOf("function");
    expect(roomAvailable).toBeTypeOf("function");
    expect(rtcMembershipEvent).toBeTypeOf("function");

    rtcMembershipEvent?.("!other-room:example.test");
    expect(matrixRtc.getRoomSession).toHaveBeenCalledTimes(1);

    roomKnown = true;
    session.memberships = [remoteMembership];
    rtcMembershipEvent?.(roomId);
    await flushPromises();

    expect(mocks.requestMatrixRtcCredentials).toHaveBeenCalledOnce();
    expect(mocks.createMatrixRtcMediaTransport).toHaveBeenCalledOnce();
    expect(mocks.startMeetingAgentRealtimeEngine).toHaveBeenCalledOnce();

    await controller.stop();
  });
});
