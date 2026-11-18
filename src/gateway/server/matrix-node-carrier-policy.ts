import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConnectParams } from "../../../packages/gateway-protocol/src/index.js";

export const MATRIX_NODE_CARRIER_MAX_BYTES = 12 * 1024;
export const MATRIX_NODE_CARRIER_METHODS = [
  "node.invoke.result",
  "node.pluginTools.update",
] as const;
const MAPS_COMMANDS: ReadonlySet<unknown> = new Set([
  "maps.search",
  "maps.directions",
  "maps.navigate",
]);

export function isMatrixNodeCarrierCommand(value: unknown): boolean {
  return MAPS_COMMANDS.has(value);
}

export function isMatrixNodeCarrierConnect(
  params: ConnectParams,
  expectedNodeId: string | undefined,
): boolean {
  const auth = params.auth;
  return (
    params.role === "node" &&
    params.client.mode === "node" &&
    params.client.id === "node-host" &&
    params.scopes?.length === 0 &&
    Boolean(params.device) &&
    (expectedNodeId === undefined || params.device?.id === expectedNodeId) &&
    (!params.caps || params.caps.length === 0) &&
    (!params.permissions || Object.keys(params.permissions).length === 0) &&
    (params.commands ?? []).length <= MAPS_COMMANDS.size &&
    (params.commands ?? []).every(isMatrixNodeCarrierCommand) &&
    Boolean(
      auth &&
      Object.keys(auth).length === 1 &&
      (auth.bootstrapToken?.trim() || (expectedNodeId !== undefined && auth.deviceToken?.trim())),
    )
  );
}

export function isMatrixNodeCarrierRequest(value: unknown): boolean {
  const frame = asOptionalObjectRecord(value);
  if (frame?.type !== "req") return false;
  if (frame.method === "node.invoke.result") return true;
  if (frame.method !== "node.pluginTools.update") return false;
  const tools = asOptionalObjectRecord(frame.params)?.tools;
  if (!Array.isArray(tools) || tools.length > MAPS_COMMANDS.size) return false;
  const commands = new Set();
  return tools.every((entry) => {
    const tool = asOptionalObjectRecord(entry);
    if (
      !tool ||
      tool.mcp !== undefined ||
      !isMatrixNodeCarrierCommand(tool.command) ||
      commands.has(tool.command)
    )
      return false;
    commands.add(tool.command);
    return true;
  });
}
