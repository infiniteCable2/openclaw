import { getLoadedChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import { userChannelIdentitySubject } from "../state/user-channel-identities.js";
import {
  listCanonicalUserChannelIdentities,
  prepareUserChannelIdentityAuthority,
} from "../state/user-channel-identity-operations.js";
import { readKnownNodeCatalog } from "./node-catalog-read.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

/** A configured pairing may be listed across the same person's private conversations. */
export async function readPersonalNodeInventory(params: {
  gateway: GatewayRequestContext;
  agentId: string;
  profileId: string;
}) {
  const { gateway, agentId, profileId } = params;
  const config = gateway.getRuntimeConfig();
  const assignments = listChannelPlugins().flatMap((plugin) =>
    (plugin.config.listPersonalNodeBindings?.(config, agentId) ?? []).map((binding) => ({
      nodeId: binding.nodeId,
      plugin,
      identity: { channelId: plugin.id, accountId: binding.accountId, senderId: binding.senderId },
    })),
  );
  if (!assignments.length) {
    return [];
  }
  const links = await listCanonicalUserChannelIdentities(profileId);
  const linked = new Set(links.map((link) => userChannelIdentitySubject(link.identity)));
  const matches = assignments.filter((assignment) =>
    linked.has(userChannelIdentitySubject(assignment.identity)),
  );
  if (!matches.length) {
    return [];
  }
  const preparation = new Map<string, ReturnType<typeof prepareUserChannelIdentityAuthority>>();
  const [catalog, verified] = await Promise.all([
    readKnownNodeCatalog(gateway.nodeRegistry),
    Promise.all(
      matches.map(async ({ nodeId, identity, plugin }) => {
        const key = userChannelIdentitySubject(identity);
        let pending = preparation.get(key);
        if (!pending) {
          pending = prepareUserChannelIdentityAuthority(identity);
          preparation.set(key, pending);
        }
        return { nodeId, plugin, authority: await pending };
      }),
    ),
  ]);
  if (gateway.getRuntimeConfig() !== config) {
    return [];
  }
  const ownersByNode = new Map<string, (() => boolean)[]>();
  for (const { nodeId, authority, plugin } of verified) {
    if (authority?.linked.profileId === profileId) {
      const checks = ownersByNode.get(nodeId) ?? [];
      checks.push(() => getLoadedChannelPlugin(plugin.id) === plugin && authority.isCurrent());
      ownersByNode.set(nodeId, checks);
    }
  }
  return catalog.nodes.flatMap((node) => {
    const isCurrent = () =>
      gateway.getRuntimeConfig() === config &&
      ownersByNode.get(node.nodeId)?.some((check) => check()) === true;
    return node.paired && isCurrent()
      ? [
          {
            nodeId: node.nodeId,
            name: node.displayName,
            model: node.modelIdentifier,
            connected: node.connected === true,
            isCurrent,
          },
        ]
      : [];
  });
}
