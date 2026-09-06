import type { IOpenIDToken, MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/client.js";
import type { CallMembership } from "matrix-js-sdk/lib/matrixrtc/CallMembership.js";
import type { LivekitTransportConfig } from "matrix-js-sdk/lib/matrixrtc/LivekitTransport.js";
import type { MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js";
import { MatrixRTCSessionManagerEvents } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSessionManager.js";

export type MatrixRtcSelfIdentity = {
  userId: string;
  deviceId: string;
};

export type MatrixRtcClientFacade = {
  onSessionStarted(listener: (roomId: string, session: MatrixRTCSession) => void): () => void;
  onSessionEnded(listener: (roomId: string, session: MatrixRTCSession) => void): () => void;
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
