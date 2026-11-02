import { conversationKnowledgeParticipantIdentity } from "../config/sessions/conversation-audience.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { prepareUserChannelIdentityAuthority } from "../state/user-channel-identity-operations.js";
import { PersonalConversationReadRefusedError } from "./session-mutation-authorization-error.js";

/** Native, source-account-bound links. These narrow personal custody; they never grant ranges. */
export function createPersonalParticipantCustody(participant: SessionParticipantIdentity) {
  const original = conversationKnowledgeParticipantIdentity(participant);
  const links = new Map<string, { profileId: string; isCurrent(): boolean }>();
  let originalLink: string | undefined;
  let recipientEntry: InternalSessionEntry | undefined;
  const qualified = new Set<string>();
  const key = (entry: InternalSessionEntry, identity: SessionParticipantIdentity) => {
    const route = entry.delivery?.kind === "external" ? entry.delivery.route : undefined;
    return JSON.stringify([
      route?.channel,
      route?.accountId,
      conversationKnowledgeParticipantIdentity(identity),
    ]);
  };
  const assertCurrent = () => {
    for (const link of links.values()) {
      if (!link.isCurrent()) {
        throw new PersonalConversationReadRefusedError(
          "Personal conversation identity link changed",
        );
      }
    }
  };
  const prepareLink = async (entry: InternalSessionEntry, identity: SessionParticipantIdentity) => {
    const route = entry.delivery?.kind === "external" ? entry.delivery.route : undefined;
    const sender = entry.delivery?.kind === "external" ? entry.delivery.origin.from : undefined;
    const creator = entry.createdActor;
    if (
      identity.type !== "remote" ||
      !route?.accountId ||
      route.channel !== identity.pluginId ||
      (sender !== identity.id &&
        !(creator?.type === "human" && creator.source === "channel" && creator.id === identity.id))
    ) {
      return undefined;
    }
    const cohort = key(entry, identity);
    qualified.add(JSON.stringify([entry.sessionId, entry.lifecycleRevision, cohort]));
    if (!links.has(cohort)) {
      const link = await prepareUserChannelIdentityAuthority({
        channelId: route.channel,
        accountId: route.accountId,
        senderId: identity.id,
      });
      if (link) {
        links.set(cohort, { profileId: link.linked.profileId, isCurrent: link.isCurrent });
      }
    }
    return cohort;
  };
  return {
    assertCurrent,
    get byteLength() {
      return Buffer.byteLength(
        JSON.stringify({
          recipientEntry,
          qualified: [...qualified],
          links: [...links].map(([cohort, link]) => [cohort, link.profileId]),
        }),
      );
    },
    async prepare(
      entry: InternalSessionEntry,
      identities: readonly SessionParticipantIdentity[],
      recipient = false,
    ) {
      if (recipient && participant.type === "remote") {
        recipientEntry = structuredClone(entry);
      }
      for (const identity of identities) {
        if (conversationKnowledgeParticipantIdentity(identity) === original) {
          continue;
        }
        if (participant.type === "remote" && recipientEntry && !originalLink) {
          originalLink = await prepareLink(recipientEntry, participant);
        }
        await prepareLink(entry, identity);
      }
      assertCurrent();
    },
    matches(entry: InternalSessionEntry, identity: SessionParticipantIdentity | undefined) {
      assertCurrent();
      if (!identity) {
        return false;
      }
      if (conversationKnowledgeParticipantIdentity(identity) === original) {
        return true;
      }
      const profile =
        participant.type === "profile" ? participant.id : links.get(originalLink ?? "")?.profileId;
      if (!profile) {
        return false;
      }
      return identity.type === "profile"
        ? identity.id === profile
        : identity.type === "remote" &&
            qualified.has(
              JSON.stringify([entry.sessionId, entry.lifecycleRevision, key(entry, identity)]),
            ) &&
            links.get(key(entry, identity))?.profileId === profile;
    },
  };
}
