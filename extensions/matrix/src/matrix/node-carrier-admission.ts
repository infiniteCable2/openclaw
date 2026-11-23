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
  bindNodeConnection(
    peer: MatrixNodePeer,
    roomId: string,
    agentId: string,
  ): { signal: AbortSignal; assertInvokeSession(sessionKey: string): void } | undefined;
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
      ? {
          agentId: row.agentId,
          expectedNodeId: device.nodeId,
          privateRequesterSenderId: device.nodeId ? peer.userId : undefined,
          allowCrossChannelAccess: Boolean(device.nodeId && device.allowCrossChannelAccess),
        }
      : undefined;
  };
  return async (peer: MatrixNodePeer, roomId: string) => {
    const original = choose(peer, roomId);
    if (!original) {
      return undefined;
    }
    // Use the active call's lifetime when a pinned link opens inside a call,
    // including when its private requester may invoke from another channel.
    // Explicitly shared links can also be opened separately outside a call.
    const bindCall = () => params.bindNodeConnection(peer, roomId, original.agentId);
    const connection = original.expectedNodeId ? bindCall() : undefined;
    if (original.expectedNodeId && !connection && !original.allowCrossChannelAccess) {
      return undefined;
    }
    const audience = await params.preparePrivateAudience({ roomId, senderId: peer.userId });
    const isSameAdmission = () => {
      const current = choose(peer, roomId);
      return (
        current?.agentId === original.agentId &&
        current.expectedNodeId === original.expectedNodeId &&
        current.privateRequesterSenderId === original.privateRequesterSenderId &&
        current.allowCrossChannelAccess === original.allowCrossChannelAccess
      );
    };
    if (!audience || connection?.signal.aborted || !isSameAdmission()) {
      return undefined;
    }
    return {
      ...original,
      signal: connection?.signal,
      assertInvokeSession(sessionKey: string) {
        // A separately approved persistent link can still serve an admitted call.
        const call = connection ?? (original.allowCrossChannelAccess ? bindCall() : undefined);
        if (!call) {
          throw new Error("Matrix Node requires the current Assistant Voice session");
        }
        call.assertInvokeSession(sessionKey);
      },
      assertCurrent() {
        connection?.signal.throwIfAborted();
        audience.assertCurrent();
        if (!isSameAdmission()) {
          throw new Error("Matrix Node room or device admission changed");
        }
      },
    };
  };
}
