import { findMatrixAccountEntry, hasImplicitMatrixAccountConfig } from "../account-selection.js";
import type { CoreConfig } from "../types.js";
import { resolveMatrixAccountConfig } from "./account-config.js";
import type { createDirectRoomTracker } from "./monitor/direct.js";
import type { MatrixNodeCarrierFacade, MatrixNodePeer } from "./sdk/matrix-node-carrier.js";

export function createMatrixNodeCarrierAdmission(params: {
  currentConfig(): CoreConfig;
  accountId: string;
  client: Pick<MatrixNodeCarrierFacade, "isEncryptedDirectRoom">;
  signal: AbortSignal;
  assertInvokeSession(
    peer: MatrixNodePeer,
    roomId: string,
    agentId: string,
    sessionKey: string,
  ): void;
  preparePrivateAudience: ReturnType<typeof createDirectRoomTracker>["preparePrivateAudience"];
}) {
  const choose = (peer: MatrixNodePeer, roomId: string) => {
    if (params.signal.aborted || !params.client.isEncryptedDirectRoom(roomId, peer.userId)) {
      return undefined;
    }
    const cfg = params.currentConfig();
    if (
      cfg.channels?.matrix?.enabled === false ||
      (!findMatrixAccountEntry(cfg, params.accountId) &&
        !hasImplicitMatrixAccountConfig(cfg, params.accountId))
    ) {
      return undefined;
    }
    const account = resolveMatrixAccountConfig({ cfg, accountId: params.accountId });
    if (
      account.enabled === false ||
      account.dm?.enabled === false ||
      account.dm?.policy === "disabled" ||
      account.rtc?.enabled !== true
    ) {
      return undefined;
    }
    const row = account.rtc.admissions?.find((entry) => entry.roomId === roomId);
    const device = row?.nodeDevices?.find((entry) => entry.deviceId === peer.deviceId);
    return row?.userId === peer.userId && device
      ? { agentId: row.agentId, expectedNodeId: device.nodeId }
      : undefined;
  };
  return async (peer: MatrixNodePeer, roomId: string) => {
    const original = choose(peer, roomId);
    if (!original) {
      return undefined;
    }
    const audience = await params.preparePrivateAudience({ roomId, senderId: peer.userId });
    const isSameAdmission = () => {
      const current = choose(peer, roomId);
      return (
        current?.agentId === original.agentId && current.expectedNodeId === original.expectedNodeId
      );
    };
    if (!audience || !isSameAdmission()) {
      return undefined;
    }
    return {
      ...original,
      assertInvokeSession(sessionKey: string) {
        params.assertInvokeSession(peer, roomId, original.agentId, sessionKey);
      },
      assertCurrent() {
        audience.assertCurrent();
        if (!isSameAdmission()) {
          throw new Error("Matrix Node room or device admission changed");
        }
      },
    };
  };
}
