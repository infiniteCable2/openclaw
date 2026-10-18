import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertExternalConversationTarget,
  resolveAgentSpeechConversationRoute,
} from "../../routing/conversation-mode.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../session-utils-store-lookup.js";
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

/** Resolve Talk ownership before aliases collapse, then retain the exact storage target. */
export function prepareTalkSessionTarget(
  cfg: OpenClawConfig,
  requestedSessionKey?: string,
  purpose: TalkSessionTargetPurpose = "conversation-input",
  connectionId?: string,
): PreparedTalkSessionTarget {
  const requestedKey = normalizeOptionalString(requestedSessionKey);
  const owner = resolveTalkSessionAgentId(cfg, requestedKey ?? "main");
  const sessionKey = requestedKey ?? resolveAgentMainSessionKey({ cfg, agentId: owner });
  const selectedKey =
    connectionId && purpose !== "settlement"
      ? selectTalkConversationKey(cfg, sessionKey, owner, connectionId)
      : sessionKey;
  const { agentId, canonicalKey, storePath } = resolveTalkSessionStorageTarget(
    cfg,
    selectedKey,
    owner,
    purpose,
  );
  return Object.freeze({ agentId, sessionKey, canonicalKey, storePath });
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

/** Revalidate a retained owner without consulting the current ambient Talk default. */
export function assertTalkSessionStorageTarget(
  cfg: OpenClawConfig,
  target: PreparedTalkSessionTarget,
  purpose: TalkSessionTargetPurpose = "conversation-input",
): void {
  const current = resolveTalkSessionStorageTarget(
    cfg,
    target.canonicalKey,
    target.agentId,
    purpose,
  );
  if (
    current.agentId !== target.agentId ||
    current.canonicalKey !== target.canonicalKey ||
    current.storePath !== target.storePath
  ) {
    throw new Error("Talk session storage target changed; retry the request");
  }
}

function resolveTalkSessionStorageTarget(
  cfg: OpenClawConfig,
  sessionKey: string,
  owner: string,
  purpose: TalkSessionTargetPurpose,
) {
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg,
    sessionKey,
    agentId: resolveConfiguredAgentId(cfg, owner),
  });
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: canonicalKey,
    agentId,
    readOnly: true,
    exactRead: true,
  });
  if (purpose === "conversation-input") {
    assertExternalConversationTarget({
      cfg,
      agentId,
      sessionKey: target.canonicalKey,
      isSystemEvent: false,
      entry: target.store[target.canonicalKey],
    });
  }
  return { agentId, canonicalKey, storePath: target.storePath };
}
