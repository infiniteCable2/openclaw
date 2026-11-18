import type { GatewayNativeApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import { registerChannelRuntimeContext } from "../infra/channel-runtime-context.js";
import type { PluginRuntimeChannel } from "../plugins/runtime/types-channel.js";
import {
  withMatrixNodeCarrierRuntime,
  type AttachMatrixNodeCarrier,
} from "./server/matrix-node-carrier-runtime.js";

export function prepareGatewayChannelAccountRuntime(params: {
  runtime?: PluginRuntimeChannel;
  channelId: string;
  accountId: string;
  signal: AbortSignal;
  approvalRuntime?: GatewayNativeApprovalRuntime;
  registration?: { pluginId: string; origin: string };
  attachMatrixNodeCarrier?: AttachMatrixNodeCarrier;
  assertCurrent(): void;
}): PluginRuntimeChannel | undefined {
  const {
    runtime,
    channelId,
    accountId,
    signal,
    approvalRuntime,
    registration,
    attachMatrixNodeCarrier,
  } = params;
  if (!runtime) {
    return undefined;
  }
  if (approvalRuntime) {
    const context: Pick<GatewayNativeApprovalRuntime, "request"> = {
      request: async <T>(
        method: GatewayNativeApprovalMethod,
        requestParams: Record<string, unknown>,
        requestOptions?: { clientDisplayName?: string },
      ): Promise<T> => {
        if (method !== "approval.resolve") {
          throw new Error(`channel approval runtime cannot dispatch ${method}`);
        }
        return await approvalRuntime.request<T>("approval.resolve", requestParams, requestOptions);
      },
    };
    registerChannelRuntimeContext({
      channelRuntime: runtime,
      channelId,
      accountId,
      capability: "approval.gateway",
      context,
      abortSignal: signal,
    });
  }
  return attachMatrixNodeCarrier &&
    channelId === "matrix" &&
    registration?.pluginId === "matrix" &&
    registration.origin === "bundled"
    ? withMatrixNodeCarrierRuntime({
        runtime,
        accountId,
        accountSignal: signal,
        assertAccountCurrent: params.assertCurrent,
        attach: attachMatrixNodeCarrier,
      })
    : runtime;
}
