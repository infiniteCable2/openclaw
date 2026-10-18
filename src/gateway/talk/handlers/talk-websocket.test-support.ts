import { expect } from "vitest";
import { captureGatewayDeviceRevocation } from "../../device-revocation.js";
import { handleGatewayRequest } from "../../server-methods.js";
import {
  bindWebSocketRequestMutationAuthority,
  readGatewayRequestMutationAuthority,
} from "../../server-methods/session-mutation-guards.js";
import type { GatewayClient } from "../../server-methods/types.js";
import type { SharedGatewaySessionGenerationState } from "../../server-shared-auth-generation.js";
import { createOperatorWsClient } from "../../server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewayWsClient } from "../../server/ws-types.js";

/** Add only transport shape to the fixture's existing verified profile and scopes. */
export function createTalkWebSocketTestClient(params: {
  identity: GatewayClient;
  connId: string;
  connectionSignal: AbortSignal;
}): GatewayWsClient {
  const { identity, connId, connectionSignal } = params;
  return {
    ...createOperatorWsClient({ connId }),
    ...identity,
    connId,
    connId,
    usesSharedGatewayAuth: false,
    authenticatedUserProfile: identity.authenticatedUserProfile
      ? {
          ...identity.authenticatedUserProfile,
          avatarRevision: identity.authenticatedUserProfile.avatarRevision ?? "",
        }
      : undefined,
    connectionSignal,
  };
}

/** Manual Talk RPCs retain the same native WS owner as authenticated dispatch. */
export async function dispatchTalkWebSocketTestRequest(
  request: Omit<
    Parameters<typeof handleGatewayRequest>[0],
    "client" | "hasCurrentClientAuthority"
  > & { client: GatewayWsClient },
  generationReader: SharedGatewaySessionGenerationState["reader"],
) {
  const { client, context } = request;
  const authority = captureGatewayDeviceRevocation(
    context,
    { deviceId: client.connect.device?.id, role: client.connect.role },
    () => !client.invalidated,
    client.connectionSignal,
  );
  try {
    const boundRequest = bindWebSocketRequestMutationAuthority(
      { ...request, hasCurrentClientAuthority: authority.isCurrent },
      client,
      generationReader,
    );
    expect(readGatewayRequestMutationAuthority(boundRequest).family).toBe("worker");
    await handleGatewayRequest(boundRequest);
  } finally {
    authority.release();
  }
}
