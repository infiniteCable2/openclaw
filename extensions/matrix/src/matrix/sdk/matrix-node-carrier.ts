import { ClientEvent, type MatrixClient } from "matrix-js-sdk/lib/client.js";
import type { ReceivedToDeviceMessage } from "matrix-js-sdk/lib/sync-accumulator.js";
import {
  MATRIX_NODE_CARRIER_EVENT,
  readMatrixNodeCarrierMessage,
  type MatrixNodeCarrierMessage,
} from "../node-carrier-wire.js";
import { withMatrixSendCurrentness } from "./send-currentness.js";

export type MatrixNodePeer = {
  userId: string;
  deviceId: string;
  deviceKey: string;
};

export function readVerifiedMatrixNodeEvent(
  payload: ReceivedToDeviceMessage,
): { peer: MatrixNodePeer; message: MatrixNodeCarrierMessage } | undefined {
  const { message, encryptionInfo } = payload;
  if (
    message.type !== MATRIX_NODE_CARRIER_EVENT ||
    encryptionInfo?.senderVerified !== true ||
    encryptionInfo.sender !== message.sender ||
    !encryptionInfo.senderDevice ||
    !encryptionInfo.senderCurve25519KeyBase64
  ) {
    return undefined;
  }
  const decoded = readMatrixNodeCarrierMessage(message.content);
  if (!decoded) {
    return undefined;
  }
  return {
    peer: {
      userId: encryptionInfo.sender,
      deviceId: encryptionInfo.senderDevice,
      deviceKey: encryptionInfo.senderCurve25519KeyBase64,
    },
    message: decoded,
  };
}

export type MatrixNodeCarrierFacade = ReturnType<typeof createMatrixNodeCarrierFacade>;

export function createMatrixNodeCarrierFacade(client: MatrixClient, owner: object) {
  return {
    isEncryptedDirectRoom(roomId: string, userId: string): boolean {
      const room = client.getRoom(roomId);
      const self = client.getUserId();
      if (!self || self === userId || !room?.hasEncryptionStateEvent()) {
        return false;
      }
      const members = room.getJoinedMembers();
      return (
        members.length === 2 &&
        members.some((member) => member.userId === self) &&
        members.some((member) => member.userId === userId)
      );
    },
    subscribe(listener: (peer: MatrixNodePeer, message: MatrixNodeCarrierMessage) => void) {
      const onMessage = (payload: ReceivedToDeviceMessage) => {
        const verified = readVerifiedMatrixNodeEvent(payload);
        if (verified) {
          listener(verified.peer, verified.message);
        }
      };
      client.on(ClientEvent.ReceivedToDeviceMessage, onMessage);
      return () => client.off(ClientEvent.ReceivedToDeviceMessage, onMessage);
    },
    async send(
      peer: MatrixNodePeer,
      message: MatrixNodeCarrierMessage,
      assertCurrent: () => void,
    ): Promise<void> {
      await withMatrixSendCurrentness(owner, assertCurrent, async () => {
        const crypto = client.getCrypto();
        if (!crypto) {
          throw new Error("Matrix node transport requires encryption");
        }
        const batch = await crypto.encryptToDeviceMessages(
          MATRIX_NODE_CARRIER_EVENT,
          [{ userId: peer.userId, deviceId: peer.deviceId }],
          message,
        );
        assertCurrent();
        const trust = await crypto.getDeviceVerificationStatus(peer.userId, peer.deviceId);
        assertCurrent();
        if (!trust?.isVerified()) {
          throw new Error("Matrix node transport peer is unverified");
        }
        const target = batch.batch[0];
        // Check the key used by Olm, including a replacement during encryption.
        // Do not enqueue authority-bearing frames in the SDK's persistent retry queue.
        const ciphertext: unknown = target?.payload.ciphertext;
        if (
          batch.eventType !== "m.room.encrypted" ||
          batch.batch.length !== 1 ||
          target?.userId !== peer.userId ||
          target.deviceId !== peer.deviceId ||
          !ciphertext ||
          typeof ciphertext !== "object" ||
          Object.keys(ciphertext).length !== 1 ||
          !Object.hasOwn(ciphertext, peer.deviceKey)
        ) {
          throw new Error("Matrix node transport peer key changed");
        }
        await client.sendToDevice(
          batch.eventType,
          new Map([[peer.userId, new Map([[peer.deviceId, target.payload]])]]),
        );
      });
    },
  };
}
