import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { listConnectedNodePluginTools } from "../gateway/node-plugin-tool-snapshot.js";
import { captureMatrixNodeCarrierRunScope } from "../gateway/server/matrix-node-carrier-authority.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";
import type { createPluginToolAllowlist } from "../plugins/tool-grant-allowlist.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  bindAgentToolAvailability,
  getAgentToolAvailabilityBinding,
} from "./agent-tool-availability.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import { matchesAnyGlobPattern } from "./glob-pattern.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const CONNECTED_DEVICE_INVENTORY = "connected_device_inventory";
const log = createSubsystemLogger("agent/device-inventory");
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

  const isCallerCurrent = () => {
    const active = getGatewayToolCallerIdentity();
    if (
      !operationalRunInstance ||
      !assertCallerCurrent ||
      active?.operationalRunInstance !== operationalRunInstance ||
      active.personalToolParticipants !== caller?.personalToolParticipants
    ) {
      return false;
    }
    assertCallerCurrent();
    return true;
  };

  const collectActions = (isCallable: (name: string) => boolean) => {
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
    return devices;
  };

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
            isPrivateRequesterProfile: (profileId) =>
              isCallerCurrent() &&
              caller?.personalToolParticipants?.isPrivateRequesterProfile(profileId) === true,
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
    extendManagedTool(tool: AnyAgentTool): AnyAgentTool {
      if (
        tool.name !== "device_inventory" ||
        getPluginToolMeta(tool)?.pluginId !== "device-management" ||
        !caller ||
        !operationalRunInstance
      ) {
        return tool;
      }
      const originalBinding = getAgentToolAvailabilityBinding(tool);
      let isCallable: (name: string) => boolean = () => false;
      const managed = copyAgentToolMetadata(tool, {
        ...tool,
        description:
          "List managed and paired devices available to this requester, with their permitted tools.",
        async execute(toolCallId, args, signal, onUpdate) {
          const profileId = isCallerCurrent()
            ? caller.personalToolParticipants?.readPrivateRequesterProfile()
            : undefined;
          const gateway =
            profileId && getInProcessGatewayRequestContext(caller.gatewayContextResolver);
          const nodes =
            gateway && profileId
              ? await import("../gateway/personal-node-inventory.js")
                  .then(({ readPersonalNodeInventory }) =>
                    readPersonalNodeInventory({ gateway, agentId: caller.agentId, profileId }),
                  )
                  .catch((error: unknown) => {
                    log.debug(
                      `Paired device lookup failed: ${error instanceof Error ? error.name : "unknown"}`,
                    );
                    return [];
                  })
              : [];
          signal?.throwIfAborted();
          const result = await tool.execute(toolCallId, args, signal, onUpdate);
          if (
            !isRecord(result.details) ||
            result.details.ok !== true ||
            !Array.isArray(result.details.devices)
          ) {
            return result;
          }
          if (
            !profileId ||
            !isCallerCurrent() ||
            !caller.personalToolParticipants?.isPrivateRequesterProfile(profileId)
          ) {
            return result;
          }
          const visible = collectActions(isCallable);
          const paired = new Map<string, DeviceActions & { connected: boolean }>(
            [...visible].map(([nodeId, info]) => [nodeId, { ...info, connected: true }]),
          );
          for (const node of nodes) {
            if (node.isCurrent() && !paired.has(node.nodeId)) {
              paired.set(node.nodeId, {
                name: node.name?.trim() || "Paired device",
                model: node.model,
                connected: node.connected,
                actions: [],
              });
            }
          }
          const requested = isRecord(args) ? args.device : undefined;
          const devices = [...paired].flatMap(([nodeId, info]) => {
            const id = "paired-" + createHash("sha256").update(nodeId).digest("hex").slice(0, 24);
            return requested === undefined || requested === id
              ? [{ id, kind: "paired_device", ...info }]
              : [];
          });
          return devices.length
            ? {
                ...result,
                ...jsonResult({
                  ...result.details,
                  devices: [...result.details.devices, ...devices],
                }),
              }
            : result;
        },
      });
      return bindAgentToolAvailability(managed, {
        ...originalBinding,
        prepare(prepared, callableTools, offeredTools) {
          originalBinding?.prepare(prepared, callableTools, offeredTools);
          isCallable = (name) => callableTools.has(name);
        },
      });
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
            if (!isCallerCurrent()) {
              throw new Error("Connected device inventory requires the current conversation turn.");
            }
            return jsonResult({ devices: [...collectActions(isCallable).values()] });
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
