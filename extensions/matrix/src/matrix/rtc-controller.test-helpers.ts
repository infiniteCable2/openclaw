import { EventEmitter } from "node:events";
import { EventType } from "matrix-js-sdk/lib/@types/event.js";
import { ClientEvent } from "matrix-js-sdk/lib/client.js";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { MatrixEvent } from "matrix-js-sdk/lib/models/event.js";
import type {
  MeetingAgentRealtimePreparation,
  MeetingRealtimeBindingsV2Params,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { vi } from "vitest";
import type { CoreConfig } from "../types.js";

const mocks = vi.hoisted(() => ({
  createMeetingRealtimeEngineBindingsV2: vi.fn((_params: MeetingRealtimeBindingsV2Params) => ({
    platform: {},
    consultAgent: vi.fn(),
    nativeInput: vi.fn(),
    connectionPresentation: _params.connectionPresentation,
  })),
  prepareMeetingAgentRealtimeEngine: vi.fn(
    async (_params: {
      onPreparation?: (preparation: MeetingAgentRealtimePreparation) => void;
    }) => ({ release: vi.fn(async () => undefined) }),
  ),
  prepareMeetingAgentGreeting: vi.fn(
    async (_params: {
      meetingSessionId: string;
      onPreparation?: (preparation: MeetingAgentRealtimePreparation) => void;
    }) => ({
      text: "Hello, caller.",
      audio: Buffer.from([1, 0]),
    }),
  ),
  startMeetingAgentRealtimeEngine: vi.fn(
    async (
      _params: Parameters<
        typeof import("openclaw/plugin-sdk/meeting-runtime").startMeetingAgentRealtimeEngine
      >[0],
    ) => ({ stop: vi.fn(async () => undefined) }),
  ),
  requestMatrixRtcCredentials: vi.fn(async () => ({
    url: "wss://rtc.example.test",
    token: "test-token",
  })),
  createMatrixRtcMediaTransport: vi.fn(
    async (
      _params: Parameters<
        typeof import("./rtc-media-transport.js").createMatrixRtcMediaTransport
      >[0],
    ) => ({
      sendKey: vi.fn(),
      stop: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    }),
  ),
}));

export function getRtcControllerMocks() {
  return mocks;
}

vi.mock("openclaw/plugin-sdk/meeting-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/meeting-runtime")>()),
  createMeetingRealtimeEngineBindingsV2: mocks.createMeetingRealtimeEngineBindingsV2,
  prepareMeetingAgentRealtimeEngine: mocks.prepareMeetingAgentRealtimeEngine,
  prepareMeetingAgentGreeting: mocks.prepareMeetingAgentGreeting,
  startMeetingAgentRealtimeEngine: mocks.startMeetingAgentRealtimeEngine,
}));

vi.mock("./rtc-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rtc-auth.js")>()),
  requestMatrixRtcCredentials: mocks.requestMatrixRtcCredentials,
}));

vi.mock("./rtc-media-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rtc-media-transport.js")>()),
  createMatrixRtcMediaTransport: mocks.createMatrixRtcMediaTransport,
}));

import { registerMatrixRtcController } from "./rtc-controller.js";
import { createMatrixRtcClientFacade } from "./sdk/matrix-rtc.js";

export const roomId = "!owner-room:example.test";
export const ownerId = "@owner:example.test";
const selfId = "@nova:example.test";

type TestRtcMode = "compatibility" | "matrix_2_0";

export async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function createHarness(
  mode: TestRtcMode,
  options: {
    emitInitialKeys?: boolean;
    emitInitialRemoteKey?: boolean;
    remoteKeyMemberId?: string;
    greeting?: boolean;
    greetingOnFailure?: "continue" | "reject";
    video?: boolean;
    cfg?: CoreConfig;
    runtime?: PluginRuntime;
    preparePrivateAudience?: Parameters<
      typeof registerMatrixRtcController
    >[0]["preparePrivateAudience"];
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
  const initialMembership = Promise.withResolvers<void>();
  const session = {
    memberships: [] as Array<typeof remoteMembership>,
    initialMembershipCalculated: initialMembership.promise,
    slotId: "m.call#ROOM",
    getRtcSlot: vi.fn(() => undefined),
    isSlotClosed: vi.fn((): boolean | undefined => undefined),
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
  const cfg: CoreConfig = options.cfg ?? {
    agents: { entries: { example_owner: {} } },
    channels: {
      matrix: {
        enabled: true,
        accounts: { default: {} },
        dm: { enabled: true, policy: "allowlist", allowFrom: [ownerId] },
        rtc: {
          enabled: true,
          authServiceUrl: "https://rtc.example.test",
          mediaBridgeCommand: "/usr/local/bin/matrix-rtc-bridge",
          transcriptionProvider: "local-stt",
          admissions: [{ roomId, userId: ownerId, agentId: "example_owner" }],
        },
      },
    },
    ...(options.video === undefined
      ? {}
      : {
          talk: {
            speech: { agentProfiles: { example_owner: { video: { enabled: options.video } } } },
          },
        }),
  };
  const controller = registerMatrixRtcController({
    client: {
      matrixRtc,
      dms: { isDm: vi.fn(() => true) },
    } as never,
    cfg,
    accountConfig: {} as never,
    accountId: "default",
    preparePrivateAudience: options.preparePrivateAudience ?? (async () => undefined),
    config: {
      authServiceUrl: "https://rtc.example.test",
      mediaBridgeCommand: "/usr/local/bin/matrix-rtc-bridge",
      transcriptionProvider: "local-stt",
      providers: {},
      toolPolicy: "owner",
      agentProfiles: {
        example_owner: {
          agentThinkingLevel: "off",
          speakCommentary: true,
          ...(options.greeting
            ? {
                greeting: {
                  enabled: true,
                  timeZone: "Europe/Berlin",
                  ...(options.greetingOnFailure ? { onFailure: options.greetingOnFailure } : {}),
                },
              }
            : {}),
        },
      },
      responseStreaming: "sentence",
      waitingAudio: {
        filePath: "/var/lib/openclaw/audio/waiting.wav",
        startDelayMs: 1_200,
        resumeDelayMs: 800,
        volume: 0.14,
      },
      admissions: [{ roomId, userId: ownerId, agentId: "example_owner" }],
    },
    runtimeEnv: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    runtime:
      options.runtime ??
      ({
        config: { current: () => cfg },
        channel: {
          routing: {
            resolveAgentRoute: vi.fn(() => ({
              agentId: "example_owner",
              sessionKey: "agent:example_owner:matrix:direct:owner",
              mainSessionKey: "agent:example_owner:main",
              matchedBy: "binding.peer",
            })),
          },
        },
      } as never),
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
    completeInitialMembership: () => initialMembership.resolve(),
    setRoomKnown(value: boolean) {
      roomKnown = value;
    },
    stickyMembershipEvent,
  };
}
