import { randomBytes } from "node:crypto";
import {
  resolveSessionPublicShare,
  type SessionPublicShareGrant,
} from "../config/sessions/session-public-share.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";

/** Call only inside the owning, authorized session mutation's commit preparation. */
export function prepareSessionPublicShareGrant(
  entry: InternalSessionEntry,
  sessionKey: string,
): SessionPublicShareGrant {
  if (entry.incognito || isIncognitoSessionKey(sessionKey)) {
    throw new Error("Incognito sessions cannot be published.");
  }
  if (entry.conversationTopology?.role === "root") {
    throw new Error("A consolidating conversation root cannot be published.");
  }
  const grant = resolveSessionPublicShare(entry) ?? {
    id: randomBytes(24).toString("hex"),
    sessionId: entry.sessionId,
    createdAt: Date.now(),
  };
  registerSecretValueForRedaction(grant.id);
  return grant;
}
