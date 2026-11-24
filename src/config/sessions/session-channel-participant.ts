import type { SessionParticipantIdentity } from "./session-participant-identity.js";
import type { InternalSessionEntry } from "./types.js";

/** The stored source must attest the same account and sender as the remote participant. */
export function resolveSessionChannelParticipant(
  entry: InternalSessionEntry,
  identity: SessionParticipantIdentity,
) {
  const delivery = entry.delivery;
  const creator = entry.createdActor;
  if (
    identity.type !== "remote" ||
    delivery?.kind !== "external" ||
    !delivery.route.accountId ||
    delivery.route.channel !== identity.pluginId ||
    (delivery.origin.from !== identity.id &&
      !(creator?.type === "human" && creator.source === "channel" && creator.id === identity.id))
  ) {
    return undefined;
  }
  return {
    channelId: delivery.route.channel,
    accountId: delivery.route.accountId,
    senderId: identity.id,
  };
}
