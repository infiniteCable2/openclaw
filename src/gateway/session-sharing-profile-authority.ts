import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";
import { authenticatedProfileUnavailableError } from "./server-methods/gateway-client-identity.js";
import { SessionSharingProfileFactsChangedError } from "./session-mutation-authorization-error.js";

/** Retain the native profile source and aliases, never just a copied identity. */
export async function prepareSessionSharingProfileAuthority(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  const prepared = await prepareUserProfileRoleAuthority(profileId, options);
  const profile = prepared && { ...prepared, aliases: new Set(prepared.aliases) };
  return () => {
    if (prepared && !prepared.isCurrent()) {
      prepared.readSource();
      throw new SessionSharingProfileFactsChangedError(
        authenticatedProfileUnavailableError(),
        prepared.readSource,
      );
    }
    return profile;
  };
}
