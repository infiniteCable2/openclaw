import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertExternalConversationTarget,
  resolveAgentSpeechConversationRoute,
} from "../../routing/conversation-mode.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import type {
  PreparedTalkSessionTarget,
  TalkSessionTargetPurpose,
} from "./session-target.types.js";

export function requirePreparedTalkSessionTarget(
  target: PreparedTalkSessionTarget | undefined,
): PreparedTalkSessionTarget {
  if (!target) {
    throw new Error("Talk session target was not prepared by the Gateway");
  }
  return target;
}

/** Resolve storage once through the native worker; retain the routing guard across awaits. */
export async function prepareTalkSessionTarget(
  cfg: OpenClawConfig,
  requestedSessionKey?: string,
  purpose: TalkSessionTargetPurpose = "conversation-input",
  connectionId?: string,
): Promise<PreparedTalkSessionTarget> {
  const requestedKey = normalizeOptionalString(requestedSessionKey);
  const owner = resolveTalkSessionAgentId(cfg, requestedKey ?? "main");
  const sessionKey = requestedKey ?? resolveAgentMainSessionKey({ cfg, agentId: owner });
  const selectedKey =
    connectionId && purpose !== "settlement"
      ? selectTalkConversationKey(cfg, sessionKey, owner, connectionId)
      : sessionKey;
  const assertCurrent = captureSessionMutationRouting(
    cfg,
    () => new Error("Talk session storage target changed; retry the request"),
    [{ sessionKey: selectedKey, agentId: owner }],
  );
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg,
    sessionKey: selectedKey,
    agentId: resolveConfiguredAgentId(cfg, owner),
  });
  const target = await resolveGatewaySessionStoreTargetInWorker({
    cfg,
    key: canonicalKey,
    agentId,
  });
  assertCurrent(cfg);
  if (purpose === "conversation-input") {
    assertExternalConversationTarget({
      cfg,
      agentId,
      sessionKey: target.canonicalKey,
      isSystemEvent: false,
      entry: target.store[target.canonicalKey],
    });
  }
  return Object.freeze({
    agentId,
    sessionKey,
    canonicalKey,
    storePath: target.storePath,
    assertCurrent,
  });
}

/** Retained targets use the native routing guard; do not synchronously reread their store. */
export function assertTalkSessionStorageTarget(
  cfg: OpenClawConfig,
  target: PreparedTalkSessionTarget,
  _purpose: TalkSessionTargetPurpose = "conversation-input",
): void {
  target.assertCurrent(cfg);
}

/** Default browser input branches by the actual Gateway connection, never by a model-supplied ID. */
function selectTalkConversationKey(
  cfg: OpenClawConfig,
  sessionKey: string,
  agentId: string,
  connectionId: string,
) {
  const identity = resolveSessionStoreIdentity({ cfg, sessionKey, agentId });
  const main = resolveAgentMainSessionKey({ cfg, agentId: identity.agentId });
  // An explicitly selected conversation is a continuation, not another automatic fork.
  if (identity.canonicalKey !== main) {
    return sessionKey;
  }
  return resolveAgentSpeechConversationRoute({
    cfg,
    agentId: identity.agentId,
    channel: "talk",
    accountId: "gateway",
    sourceSessionKey: sessionKey,
    conversationId: connectionId,
  }).sessionKey;
}
