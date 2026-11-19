import type { listConnectedNodePluginTools } from "../gateway/node-plugin-tool-snapshot.js";
import { captureMatrixNodeCarrierRunScope } from "../gateway/server/matrix-node-carrier-authority.js";
import type { createPluginToolAllowlist } from "../plugins/tool-grant-allowlist.js";
import { bindAgentToolAvailability } from "./agent-tool-availability.js";
import { matchesAnyGlobPattern } from "./glob-pattern.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const CONNECTED_DEVICE_INVENTORY = "connected_device_inventory";
type PublishedTool = ReturnType<typeof listConnectedNodePluginTools>[number];
type DeviceActions = {
  name: string;
  model?: string;
  actions: { command: string; tool: string }[];
};

/** Assemble discovery from the same approved tools and native conversation as dispatch. */
export function prepareConnectedDeviceInventory(
  sessionKey: string | undefined,
  assertCallerCurrent: (() => void) | undefined,
) {
  const caller = getGatewayToolCallerIdentity();
  const operationalRunInstance = caller?.operationalRunInstance;
  const identity =
    caller && operationalRunInstance
      ? { agentId: caller.agentId, sessionKey: caller.sessionKey, operationalRunInstance }
      : undefined;
  const deviceScopes = new Map<string, (() => boolean) | undefined>();
  const actions: { entry: PublishedTool; command: string; tool: string }[] = [];

  return {
    admits(entry: PublishedTool) {
      const binding = entry.matrixCarrier;
      if (!binding) {
        return true;
      }
      if (!assertCallerCurrent) {
        return false;
      }
      if (!deviceScopes.has(entry.nodeId)) {
        deviceScopes.set(
          entry.nodeId,
          captureMatrixNodeCarrierRunScope({
            binding,
            nodeId: entry.nodeId,
            identity,
            sessionKey,
          }),
        );
      }
      return deviceScopes.get(entry.nodeId)?.() === true;
    },
    record(entry: PublishedTool, command: string, tool: string) {
      if (entry.matrixCarrier) {
        actions.push({ entry, command, tool });
      }
    },
    createTool(params: {
      existingNames: ReadonlySet<string>;
      allowlist: ReturnType<typeof createPluginToolAllowlist>;
      denylist: Parameters<typeof matchesAnyGlobPattern>[1];
    }): AnyAgentTool | undefined {
      const { existingNames, allowlist, denylist } = params;
      if (
        !actions.length ||
        !assertCallerCurrent ||
        existingNames.has(CONNECTED_DEVICE_INVENTORY) ||
        (!allowlist.includesDefaults && !allowlist.allowsToolName(CONNECTED_DEVICE_INVENTORY)) ||
        matchesAnyGlobPattern(CONNECTED_DEVICE_INVENTORY, denylist) ||
        matchesAnyGlobPattern("group:plugins", denylist)
      ) {
        return undefined;
      }
      let isCallable: (name: string) => boolean = () => false;
      return bindAgentToolAvailability(
        {
          name: CONNECTED_DEVICE_INVENTORY,
          label: "Connected Devices",
          description:
            "Find paired devices available in this conversation and the exact tools for their approved actions. Use the listed action tools to operate them.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            assertCallerCurrent();
            if (getGatewayToolCallerIdentity()?.operationalRunInstance !== operationalRunInstance) {
              throw new Error("Connected device inventory requires the current conversation turn.");
            }
            const devices = new Map<string, DeviceActions>();
            for (const { entry, command, tool } of actions) {
              if (!isCallable(tool) || !deviceScopes.get(entry.nodeId)?.()) {
                continue;
              }
              const device: DeviceActions = devices.get(entry.nodeId) ?? {
                name: entry.displayName?.trim() || "Paired device",
                model: entry.modelIdentifier,
                actions: [],
              };
              device.actions.push({ command, tool });
              devices.set(entry.nodeId, device);
            }
            return jsonResult({ devices: [...devices.values()] });
          },
        },
        {
          prepare(_tool, callableTools) {
            isCallable = (name) => callableTools.has(name);
          },
        },
      );
    },
  };
}
