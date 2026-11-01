import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig, GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import { connectReq, CONTROL_UI_CLIENT, openWs, testState } from "./server.auth.test-helpers.js";

export const BROWSER_ORIGIN = "https://control.example.com";

export async function configureGatewayAuth(
  auth: GatewayAuthConfig,
  options?: { tailscaleMode?: "serve"; roles?: GatewayOperatorRolesConfig },
): Promise<void> {
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      ...(options?.tailscaleMode ? { tailscale: { mode: options.tailscaleMode } } : {}),
      ...(options?.roles ? { roles: options.roles } : {}),
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });
}

export function responseAuth(
  response: Awaited<ReturnType<typeof connectReq>>,
): HelloOk["auth"] | undefined {
  return (response.payload as HelloOk | undefined)?.auth;
}

export function connectIdentity(
  ws: Awaited<ReturnType<typeof openWs>>,
  options: NonNullable<Parameters<typeof connectReq>[1]>,
) {
  return connectReq(ws, {
    prePairDevice: true,
    client: CONTROL_UI_CLIENT,
    browserOrigin: BROWSER_ORIGIN,
    ...options,
  });
}
