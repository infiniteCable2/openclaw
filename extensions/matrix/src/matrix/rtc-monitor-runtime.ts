import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { getChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { CoreConfig } from "../types.js";
import { createMatrixNodeCarrierAdmission } from "./node-carrier-admission.js";
import { registerMatrixNodeCarrier, type MatrixNodeCarrierAttach } from "./node-carrier.js";
import { registerMatrixRtcController } from "./rtc-controller.js";

export async function registerMatrixRtcMonitor(
  params: Parameters<typeof registerMatrixRtcController>[0] & {
    abortSignal: AbortSignal;
    channelRuntime?: ChannelRuntimeSurface;
  },
) {
  const enabled = params.config.admissions.some((admission) => admission.nodeDevices?.length);
  const host = enabled
    ? (getChannelRuntimeContext({
        channelRuntime: params.channelRuntime,
        channelId: "matrix",
        accountId: params.accountId,
        capability: "matrix.node-carrier",
      }) as { attachGateway?: MatrixNodeCarrierAttach } | undefined)
    : undefined;
  if (enabled && typeof host?.attachGateway !== "function") {
    throw new Error("Matrix Node devices require a host-owned Gateway carrier");
  }
  const client = host && params.client.createNodeCarrier();
  const rtc = registerMatrixRtcController(params);
  try {
    const node =
      client && host?.attachGateway
        ? registerMatrixNodeCarrier({
            client,
            signal: params.abortSignal,
            attachGateway: host.attachGateway,
            admit: createMatrixNodeCarrierAdmission({
              currentConfig: () => params.runtime.config.current() as CoreConfig,
              accountId: params.accountId,
              client,
              signal: params.abortSignal,
              preparePrivateAudience: params.preparePrivateAudience,
              assertInvokeSession: (peer, roomId, agentId, sessionKey) =>
                rtc.assertNodeInvocation({
                  roomId,
                  agentId,
                  userId: peer.userId,
                  deviceId: peer.deviceId,
                  sessionKey,
                }),
            }),
          })
        : undefined;
    return {
      startExisting: rtc.startExisting,
      invalidateNodeRoom: (roomId?: string) => node?.invalidateRoom(roomId),
      stop(options?: Parameters<typeof rtc.stop>[0]) {
        node?.stop();
        return rtc.stop(options);
      },
    };
  } catch (error) {
    await rtc.stop({ waitForCleanup: true });
    throw error;
  }
}
