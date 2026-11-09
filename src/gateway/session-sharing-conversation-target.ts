import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExternalConversationTarget } from "../routing/conversation-mode.js";
import {
  sessionMutationTargetChanged,
  type resolvePreparedTalkAuthorizationTarget,
} from "./session-sharing-authorization.js";

export function createConversationTalkInputAuthorizer(
  prepared: Pick<
    ReturnType<typeof resolvePreparedTalkAuthorizationTarget>,
    "talkInput" | "talkSessionTarget"
  >,
  method: string,
) {
  const { talkInput, talkSessionTarget } = prepared;
  // Only inspect the root role after native access policy has admitted the row.
  const authorize = (cfg: OpenClawConfig, entry?: InternalSessionEntry) => {
    if (
      !talkSessionTarget ||
      (talkInput && talkInput.kind !== "relay" && talkInput.purpose === "settlement")
    ) {
      return null;
    }
    try {
      assertExternalConversationTarget({
        cfg,
        agentId: talkSessionTarget.agentId,
        sessionKey: talkSessionTarget.canonicalKey,
        entry,
        isSystemEvent: false,
      });
      return null;
    } catch (error) {
      return errorShape(
        ErrorCodes.INVALID_REQUEST,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return {
    authorize,
    // A target admitted earlier has changed; do not disclose its new internal role.
    assertAdmittedCurrent(cfg: OpenClawConfig, entry: InternalSessionEntry) {
      if (talkSessionTarget && authorize(cfg, entry)) {
        throw sessionMutationTargetChanged(method, talkSessionTarget.canonicalKey);
      }
    },
  };
}
