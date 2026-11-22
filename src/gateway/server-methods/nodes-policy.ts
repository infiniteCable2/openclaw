import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  isPrivateGoENodeCommand,
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_NETWORK_DEVICE_HISTORY_COMMAND,
  NODE_NETWORK_DEVICE_READ_COMMAND,
  NODE_NETWORK_DEVICE_READ_V2_COMMAND,
} from "../../infra/node-commands.js";
import { ADMIN_SCOPE, PAIRING_SCOPE } from "../operator-scopes.js";
import { respondError } from "./response.js";
import type { GatewayClient, RespondFn } from "./shared-types.js";

function isValidGoEHistoryQuery(args: Record<string, unknown>): boolean {
  const { limit, from, to, offset } = args;
  return (
    Object.keys(args).every(
      (key) =>
        key === "plugin" ||
        key === "deviceKey" ||
        key === "limit" ||
        key === "from" ||
        key === "to" ||
        key === "offset",
    ) &&
    Object.hasOwn(args, "limit") &&
    typeof limit === "number" &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= 20 &&
    (!Object.hasOwn(args, "from") || Number.isSafeInteger(from)) &&
    (!Object.hasOwn(args, "to") || Number.isSafeInteger(to)) &&
    (!Object.hasOwn(args, "offset") ||
      (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0)) &&
    (typeof from !== "number" || typeof to !== "number" || from <= to)
  );
}

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
    if (
      isMatrix ||
      (command !== NODE_NETWORK_DEVICE_READ_COMMAND &&
        command !== NODE_NETWORK_DEVICE_READ_V2_COMMAND &&
        !isPrivateGoENodeCommand(command))
    ) {
      return false;
    }
    respondError(respond, ErrorCodes.FORBIDDEN, `${command} requires a Matrix Node`);
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
    if (command === NODE_NETWORK_DEVICE_READ_V2_COMMAND || isPrivateGoENodeCommand(command)) {
      const history = command === NODE_NETWORK_DEVICE_HISTORY_COMMAND;
      const args = asOptionalObjectRecord(rawParams);
      if (
        args &&
        !Array.isArray(args) &&
        Object.hasOwn(args, "plugin") &&
        args.plugin === "go-e" &&
        Object.hasOwn(args, "deviceKey") &&
        typeof args.deviceKey === "string" &&
        /^[0-9]{6}$/u.test(args.deviceKey) &&
        (history ? isValidGoEHistoryQuery(args) : Object.keys(args).length === 2)
      ) {
        return false;
      }
      respondError(respond, ErrorCodes.INVALID_REQUEST, `Invalid ${command} parameters`, {
        details: { code: "INVALID_PARAMS" },
      });
      return true;
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
