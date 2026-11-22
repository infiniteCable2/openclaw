import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_NETWORK_DEVICE_READ_COMMAND,
} from "../../infra/node-commands.js";
import { ADMIN_SCOPE, PAIRING_SCOPE } from "../operator-scopes.js";
import { respondError } from "./response.js";
import type { GatewayClient, RespondFn } from "./shared-types.js";

export const nodeInvokePolicy = {
  wakeThrottleMs: 15_000,
  wakeNudgeThrottleMs: 10 * 60_000,
  pendingActionTtlMs: 10 * 60_000,
  pendingActionMaxPerNode: 64,
  canReadPendingNodePairing(client: GatewayClient | null): boolean {
    const scopes = client?.connect.scopes ?? [];
    return scopes.includes(ADMIN_SCOPE) || scopes.includes(PAIRING_SCOPE);
  },
  rejectUnsupportedTransport(command: string, isMatrix: boolean, respond: RespondFn): boolean {
    if (command !== NODE_NETWORK_DEVICE_READ_COMMAND || isMatrix) {
      return false;
    }
    respondError(respond, ErrorCodes.FORBIDDEN, "network.device.read requires a Matrix Node");
    return true;
  },
  rejectUnsupportedRequest(command: string, rawParams: unknown, respond: RespondFn): boolean {
    if (command === NODE_NETWORK_DEVICE_READ_COMMAND) {
      const args = asOptionalObjectRecord(rawParams);
      if (!args || Array.isArray(args) || Object.keys(args).length !== 0) {
        respondError(respond, ErrorCodes.INVALID_REQUEST, "network.device.read requires {}");
        return true;
      }
      return false;
    }
    if (command !== NODE_AGENT_CLI_CLAUDE_RUN_COMMAND) {
      return false;
    }
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "node.invoke does not allow Claude agent runs; use sessions.catalog.continue",
        { details: { command } },
      ),
    );
    return true;
  },
};
