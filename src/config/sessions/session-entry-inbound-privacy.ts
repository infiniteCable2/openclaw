import {
  capturePrivateConversationCreationAudience,
  readConversationPrivateAudience,
  type ConversationPrivateAudience,
} from "../../sessions/conversation-private-audience.js";
import type { RecordInboundSessionMetaParams } from "./runtime-types.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-scope.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Metadata can create the native generation before reply initialization sees it. */
export function prepareInboundSessionCreationPrivacy(
  scope: SessionAccessScope,
  ctx: RecordInboundSessionMetaParams["ctx"] | undefined,
) {
  const target = resolveSqliteScope(scope);
  const original = ctx && readConversationPrivateAudience(ctx);
  let creationAudience: ConversationPrivateAudience | undefined;
  return {
    patch(entry: SessionEntry | undefined): Partial<SessionEntry> {
      // Replanning must never retain creation authority for an already existing row.
      creationAudience = undefined;
      creationAudience = capturePrivateConversationCreationAudience({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        entry,
        audience: original,
      });
      return creationAudience ? { visibility: "draft" } : {};
    },
    assertCurrent() {
      creationAudience?.assertCurrent();
    },
  };
}
