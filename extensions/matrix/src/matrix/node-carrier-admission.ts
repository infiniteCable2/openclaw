import { findMatrixAccountEntry, hasImplicitMatrixAccountConfig } from "../account-selection.js";
import type { CoreConfig } from "../types.js";
import { resolveMatrixAccountConfig } from "./account-config.js";
import type { createDirectRoomTracker } from "./monitor/direct.js";
import type { MatrixNodeCarrierFacade, MatrixNodePeer } from "./sdk/matrix-node-carrier.js";

function resolveEnabledCarrierAccount(cfg: CoreConfig, accountId: string) {
  if (
    cfg.channels?.matrix?.enabled === false ||
    (!findMatrixAccountEntry(cfg, accountId) && !hasImplicitMatrixAccountConfig(cfg, accountId))
  ) {
    return undefined;
  }
  const account = resolveMatrixAccountConfig({ cfg, accountId });
  return account.enabled !== false &&
    account.dm?.enabled !== false &&
    account.dm?.policy !== "disabled" &&
    account.rtc?.enabled === true
    ? account
    : undefined;
}

export function listMatrixPersonalNodeBindings(
  cfg: CoreConfig,
  agentId: string,
  accountIds: readonly string[],
) {
  return accountIds.flatMap((accountId) => {
    const account = resolveEnabledCarrierAccount(cfg, accountId);
    const rooms = new Set<string>();
    return (account?.rtc?.admissions ?? []).flatMap((row) => {
      // The live carrier selects the first admission for a room.
      if (rooms.has(row.roomId)) {
        return [];
      }
      rooms.add(row.roomId);
      return row.agentId === agentId
        ? (row.nodeDevices ?? []).flatMap(({ nodeId }) =>
            nodeId ? [{ accountId, senderId: row.userId, nodeId }] : [],
          )
        : [];
    });
  });
}

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
    const account = resolveEnabledCarrierAccount(params.currentConfig(), params.accountId);
    const row = account?.rtc?.admissions?.find((entry) => entry.roomId === roomId);
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
