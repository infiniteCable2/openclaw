import type { ConversationListItem } from "../../packages/gateway-protocol/src/schema/agent.js";
import type { AnyChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ConversationRecord } from "../config/sessions/conversation-registry.types.js";

type ConversationChannelPresentation = Pick<AnyChannelPlugin, "meta" | "capabilities">;

/** Callers select and authorize addresses before resolving any channel metadata. */
export function presentConversationList(
  conversations: readonly ConversationRecord[],
  resolveChannel: (channel: string) => ConversationChannelPresentation | undefined,
): ConversationListItem[] {
  const plugins = new Map<string, ConversationChannelPresentation | undefined>();
  return conversations.map((conversation) => {
    if (!plugins.has(conversation.channel)) {
      plugins.set(conversation.channel, resolveChannel(conversation.channel));
    }
    return presentConversationListItem(conversation, plugins.get(conversation.channel));
  });
}

/** Presents an authorized external address without exposing its backing session or authority. */
export function presentConversationListItem(
  conversation: ConversationRecord,
  plugin?: ConversationChannelPresentation,
): ConversationListItem {
  const row: ConversationListItem = {
    conversationRef: conversation.conversationRef,
    channel: conversation.channel,
    accountId: conversation.accountId,
    kind: conversation.kind,
    target: conversation.target,
    firstSeenAt: conversation.firstSeenAt,
    lastSeenAt: conversation.lastSeenAt,
  };
  if (conversation.threadId) {
    row.threadId = conversation.threadId;
  }
  if (conversation.label) {
    row.label = conversation.label;
  }
  if (conversation.contextRelation) {
    row.contextRelation = conversation.contextRelation;
  }
  const channelLabel = plugin?.meta.label.trim();
  if (channelLabel) {
    row.channelLabel = channelLabel;
  }
  const media = plugin?.capabilities.media;
  const voiceOutput = plugin?.capabilities.tts?.voice?.synthesisTarget;
  if (media !== undefined || voiceOutput !== undefined) {
    row.channelCapabilities = {
      ...(media !== undefined ? { media } : {}),
      ...(voiceOutput !== undefined ? { voiceOutput } : {}),
    };
  }
  return row;
}
