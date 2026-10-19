import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ChatType } from "../channels/chat-type.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import { resolveAgentConversationRootSessionKey } from "../config/sessions/session-conversation-root-key.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { DmScope, GroupScope } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeRouteBindingId } from "./binding-scope.js";
import { buildAgentPeerSessionKey } from "./session-key.js";

/** Final ingress validation also covers command and conversation-binding overrides. */
export function assertExternalConversationTarget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  isSystemEvent: boolean;
  entry?: InternalSessionEntry;
}): void {
  if (params.isSystemEvent) {
    return;
  }
  // Config opt-out is not a migration of the persisted headless conversation.
  if (params.entry?.conversationTopology?.role === "root") {
    throw new Error(
      "A consolidating conversation root cannot receive external input. Explicitly migrate it before changing conversation mode.",
    );
  }
  if (resolveAgentConversationMode(params.cfg, params.agentId) !== "branches") {
    return;
  }
  if (params.cfg.session?.scope === "global") {
    throw new Error(
      "Branch conversations require per-agent roots; session.scope cannot be global.",
    );
  }
  const root = resolveAgentConversationRootSessionKey({
    agentId: params.agentId,
    cfg: params.cfg,
  });
  if (params.sessionKey === root) {
    throw new Error(
      "Branch conversation mode reserves its internal root for consolidation. Route this input to a conversation branch.",
    );
  }
}

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
  const rootSessionKey =
    mode === "branches"
      ? resolveAgentConversationRootSessionKey({ cfg: params.cfg, agentId: params.agentId })
      : resolveCanonicalMainSessionKey({
          agentId: params.agentId,
          mainKey: params.cfg.session?.mainKey,
          sessionScope: params.cfg.session?.scope,
        });
  return { mode, sessionKey, rootSessionKey, dmScope, groupScope };
}

/** An audio connection is a direct conversation, not a spawned task. No context/read grant. */
export function resolveAgentSpeechConversationRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId: string;
  sourceSessionKey: string;
  conversationId: string;
}) {
  if (!params.sourceSessionKey.trim() || !params.conversationId.trim()) {
    throw new Error("Speech routing requires its admitted source and connection identity");
  }
  const selected = resolveAgentConversationRoute({
    ...params,
    peer: { kind: "direct", id: `speech:${params.conversationId}` },
    dmScope: params.cfg.session?.dmScope ?? "main",
    groupScope: "per-group",
  });
  return {
    ...selected,
    sessionKey: selected.mode === "branches" ? selected.sessionKey : params.sourceSessionKey,
  };
}
