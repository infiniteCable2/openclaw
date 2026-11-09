import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { prepareSessionCreatorProfile } from "./session-creator.js";
import { createProfileSessionEntryFilter } from "./session-sharing-read.js";

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
