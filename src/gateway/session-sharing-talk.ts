import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExternalConversationTarget } from "../routing/conversation-mode.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import { isAgentRunStartMethod } from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import {
  sessionMutationTargetChanged,
  type SessionMutationAuthorizationParams,
} from "./session-sharing-authorization.js";
import { resolveTalkSessionTargetInput } from "./session-sharing-target-input.js";
import { assertTalkSessionStorageTarget, prepareTalkSessionTarget } from "./talk/session-target.js";
import type { PreparedTalkSessionTarget } from "./talk/session-target.types.js";

/** Keep address selection, post-access input policy and retained Talk routing in one owner. */
export function prepareSessionSharingTalkAdmission(
  request: SessionMutationAuthorizationParams,
  getConfig: () => OpenClawConfig,
) {
  const input = resolveTalkSessionTargetInput(
    request.method,
    request.requestParams,
    request.client?.connId,
  );
  let target: PreparedTalkSessionTarget | undefined;
  if (input && input.kind !== "request") {
    assertTalkSessionStorageTarget(getConfig(), input.target, "address-resolution");
    target = input.target;
  } else if (input) {
    target = prepareTalkSessionTarget(
      getConfig(),
      input.sessionKey,
      input.purpose === "settlement" ? "settlement" : "address-resolution",
      request.client?.connId,
    );
  }
  const authorizesAgentRun = isAgentRunStartMethod(request.method, request.requestParams);
  const authorizeCreation = (currentCfg: OpenClawConfig) =>
    target && authorizesAgentRun
      ? authorizeGatewaySessionCreation({
          cfg: currentCfg,
          client: request.client,
          agentId: target.agentId,
        })
      : null;
  return {
    input,
    target,
    authorizeCreation,
    // Consume only the exact row already admitted by native creation and visibility
    // policy. Looking at its root role during address discovery would disclose it.
    authorizeInputTarget(
      currentCfg: OpenClawConfig,
      entry?: InternalSessionEntry,
    ): ErrorShape | null {
      if (!target || (input && input.kind !== "relay" && input.purpose === "settlement")) {
        return null;
      }
      try {
        assertExternalConversationTarget({
          cfg: currentCfg,
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          isSystemEvent: false,
          entry,
        });
        return null;
      } catch (error) {
        return errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    assertCurrent(currentCfg: OpenClawConfig) {
      if (!input || !target) {
        return;
      }
      let current: PreparedTalkSessionTarget;
      try {
        if (input.kind !== "request") {
          if (!input.isCurrent()) {
            throw sessionMutationTargetChanged(request.method, target.sessionKey);
          }
          assertTalkSessionStorageTarget(
            currentCfg,
            target,
            input.kind === "retained" ? input.purpose : undefined,
          );
          current = target;
        } else {
          current = prepareTalkSessionTarget(
            currentCfg,
            input.sessionKey,
            input.purpose,
            request.client?.connId,
          );
        }
      } catch {
        throw sessionMutationTargetChanged(request.method, target.sessionKey);
      }
      if (
        current.agentId !== target.agentId ||
        current.sessionKey !== target.sessionKey ||
        current.canonicalKey !== target.canonicalKey ||
        current.storePath !== target.storePath
      ) {
        throw sessionMutationTargetChanged(request.method, target.sessionKey);
      }
      const error = authorizeCreation(request.context.getCommittedRuntimeConfig?.() ?? currentCfg);
      if (error) {
        throw new SessionMutationAuthorizationChangedError(error);
      }
    },
  };
}
