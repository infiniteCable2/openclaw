import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ChatType } from "../channels/chat-type.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import type { DmScope, GroupScope } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeRouteBindingId } from "./binding-scope.js";
import { buildAgentPeerSessionKey } from "./session-key.js";

/**
 * Select a default external conversation without assigning task-spawn authority.
 * An explicitly admitted connection handoff can retain its existing branch;
 * choosing this default is not a reason to fork again when a transport changes.
 */
export function resolveAgentConversationRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId: string;
  peer?: { kind: ChatType; id: string } | null;
  dmScope: DmScope;
  groupScope: GroupScope;
}) {
  const mode = resolveAgentConversationMode(params.cfg, params.agentId);
  if (mode === "branches" && params.cfg.session?.scope === "global") {
    throw new Error(
      "Branch conversations require per-agent roots; session.scope cannot be global.",
    );
  }
  const dmScope = mode === "branches" ? "per-account-channel-peer" : params.dmScope;
  const groupScope = mode === "branches" ? "per-group" : params.groupScope;
  if (mode === "branches" && (!params.channel.trim() || !params.peer?.id.trim())) {
    throw new Error("Branch conversation routing requires a channel and an identified peer.");
  }
  const sessionKey = buildAgentPeerSessionKey({
    agentId: params.agentId,
    mainKey: params.cfg.session?.mainKey,
    channel: normalizeLowercaseStringOrEmpty(params.channel) || "unknown",
    accountId: params.accountId,
    peerKind: params.peer?.kind ?? "direct",
    peerId: params.peer ? normalizeRouteBindingId(params.peer.id) || "unknown" : null,
    dmScope,
    groupScope,
    identityLinks: params.cfg.session?.identityLinks,
  });
  const rootSessionKey = resolveCanonicalMainSessionKey({
    agentId: params.agentId,
    mainKey: params.cfg.session?.mainKey,
    sessionScope: params.cfg.session?.scope,
  });
  return { mode, sessionKey, rootSessionKey, dmScope, groupScope };
}
