import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "./session-creator.js";
import { resolveSessionVisibility } from "./session-sharing-policy.js";

/** Caller identity and role facts must be current in the synchronous consuming frame. */
export function createSessionReadEntryFilter(
  params: {
    profileId: string | undefined;
    admin: boolean;
    system: boolean;
    rolesConfigured: boolean;
    sessionCap: GatewayOperatorRoleDefinition["sessions"]["others"] | undefined;
  },
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
) {
  if (params.admin || (!params.profileId && params.system)) {
    return undefined;
  }
  if (!params.profileId) {
    return params.rolesConfigured ? () => false : undefined;
  }
  return createProfileSessionEntryFilter(
    { profileId: params.profileId, sessionCap: params.sessionCap },
    isCreator,
  );
}

export function createProfileSessionEntryFilter(
  params: {
    profileId: string;
    sessionCap?: GatewayOperatorRoleDefinition["sessions"]["others"];
  },
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
) {
  // Unprepared filters may survive yields and must read current aliases.
  const creatorMatches = isCreator ?? ((actor) => isSessionCreatorProfile(actor, params.profileId));
  return (
    sessionKey: string | undefined,
    entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito">,
  ) =>
    entry.incognito !== true &&
    !isIncognitoSessionKey(sessionKey) &&
    (creatorMatches(entry.createdActor) ||
      (params.sessionCap !== "none" && resolveSessionVisibility(entry) !== "draft"));
}
