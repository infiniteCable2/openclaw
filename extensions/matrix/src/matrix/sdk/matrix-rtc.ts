import { EventType } from "matrix-js-sdk/lib/@types/event.js";
import { decodeBase64 } from "matrix-js-sdk/lib/base64.js";
import {
  ClientEvent,
  type IOpenIDToken,
  type MatrixClient as MatrixJsClient,
} from "matrix-js-sdk/lib/client.js";
import type { CallMembership } from "matrix-js-sdk/lib/matrixrtc/CallMembership.js";
import type { LivekitTransportConfig } from "matrix-js-sdk/lib/matrixrtc/LivekitTransport.js";
import type { MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { MatrixRTCSessionManagerEvents } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSessionManager.js";
import type { MatrixEvent } from "matrix-js-sdk/lib/models/event.js";
import type { Room } from "matrix-js-sdk/lib/models/room.js";
import type { ReceivedToDeviceMessage } from "matrix-js-sdk/lib/sync-accumulator.js";

export type MatrixRtcSelfIdentity = {
  userId: string;
  deviceId: string;
};

export type MatrixRtcIncomingMediaKey = {
  roomId: string;
  userId: string;
  deviceId: string;
  memberId: string;
  index: number;
  key: Uint8Array<ArrayBuffer>;
  receivedAt: number;
  sentAt?: number;
};

export type MatrixRtcClientFacade = {
  onSessionStarted(listener: (roomId: string, session: MatrixRTCSession) => void): () => void;
  onSessionEnded(listener: (roomId: string, session: MatrixRTCSession) => void): () => void;
  onRoomAvailable(listener: (roomId: string) => void): () => void;
  onRtcMembershipEvent(listener: (roomId: string) => void): () => void;
  onIncomingMediaKey(listener: (key: MatrixRtcIncomingMediaKey) => void): () => void;
  getRoomSession(roomId: string): MatrixRTCSession | undefined;
  getJoinedUserIds(roomId: string): string[];
  getOpenIdToken(): Promise<IOpenIDToken>;
  getPreferredLivekitTransport(): Promise<LivekitTransportConfig>;
  getSelfIdentity(): MatrixRtcSelfIdentity;
};

function asLivekitTransport(value: unknown): LivekitTransportConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const transport = value as { type?: unknown; livekit_service_url?: unknown };
  if (transport.type !== "livekit" || typeof transport.livekit_service_url !== "string") {
    return null;
  }
  return value as LivekitTransportConfig;
}

export function createMatrixRtcClientFacade(client: MatrixJsClient): MatrixRtcClientFacade {
  return {
    onSessionStarted(listener) {
      client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, listener);
      return () => client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionStarted, listener);
    },
    onSessionEnded(listener) {
      client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, listener);
      return () => client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionEnded, listener);
    },
    onRoomAvailable(listener) {
      const onRoom = (room: Room) => listener(room.roomId);
      client.on(ClientEvent.Room, onRoom);
      return () => client.off(ClientEvent.Room, onRoom);
    },
    onRtcMembershipEvent(listener) {
      const onEvent = (event: MatrixEvent) => {
        if (
          !event.unstableStickyExpiresAt ||
          event.getType() !== EventType.RTCMembership.toString()
        ) {
          return;
        }
        const roomId = event.getRoomId();
        if (roomId) {
          listener(roomId);
        }
      };
      client.on(ClientEvent.Event, onEvent);
      return () => client.off(ClientEvent.Event, onEvent);
    },
    onIncomingMediaKey(listener) {
      const onMessage = (payload: ReceivedToDeviceMessage) => {
        const { message, encryptionInfo } = payload;
        if (
          message.type !== EventType.CallEncryptionKeysPrefix.toString() ||
          !encryptionInfo ||
          message.sender !== encryptionInfo.sender
        ) {
          return;
        }
        const content = message.content;
        const keys = content.keys;
        const member = content.member;
        if (
          typeof content.room_id !== "string" ||
          !keys ||
          typeof keys !== "object" ||
          !member ||
          typeof member !== "object" ||
          typeof keys.key !== "string" ||
          !Number.isInteger(keys.index) ||
          keys.index < 0 ||
          keys.index > 255 ||
          typeof member.claimed_device_id !== "string" ||
          !member.claimed_device_id ||
          (encryptionInfo.senderDevice !== undefined &&
            encryptionInfo.senderDevice !== member.claimed_device_id)
        ) {
          return;
        }
        const memberId =
          typeof member.id === "string" && member.id
            ? member.id
            : `${message.sender}:${member.claimed_device_id}`;
        try {
          const key = decodeBase64(keys.key);
          if (key.byteLength !== 16) {
            return;
          }
          listener({
            roomId: content.room_id,
            userId: message.sender,
            deviceId: member.claimed_device_id,
            memberId,
            index: keys.index,
            key,
            receivedAt: Date.now(),
            ...(typeof content.sent_ts === "number" && Number.isFinite(content.sent_ts)
              ? { sentAt: content.sent_ts }
              : {}),
          });
        } catch {
          // Invalid base64 is not a usable media key.
        }
      };
      client.on(ClientEvent.ReceivedToDeviceMessage, onMessage);
      return () => client.off(ClientEvent.ReceivedToDeviceMessage, onMessage);
    },
    getRoomSession(roomId) {
      const room = client.getRoom(roomId);
      return room ? client.matrixRTC.getRoomSession(room) : undefined;
    },
    getJoinedUserIds(roomId) {
      const room = client.getRoom(roomId);
      if (!room) {
        return [];
      }
      return [...new Set(room.getJoinedMembers().map((member) => member.userId))].toSorted();
    },
    async getOpenIdToken() {
      return await client.getOpenIdToken();
    },
    async getPreferredLivekitTransport() {
      const transports = await client["_unstable_getRTCTransports"]();
      const livekit = transports.map(asLivekitTransport).find(Boolean);
      if (!livekit) {
        throw new Error("Matrix homeserver did not advertise a LiveKit MatrixRTC transport");
      }
      return livekit;
    },
    getSelfIdentity() {
      const userId = client.getUserId()?.trim();
      const deviceId = client.getDeviceId()?.trim();
      if (!userId || !deviceId) {
        throw new Error("MatrixRTC requires an authenticated Matrix user and device ID");
      }
      return { userId, deviceId };
    },
  };
}

export type { CallMembership, MatrixRTCSession };
