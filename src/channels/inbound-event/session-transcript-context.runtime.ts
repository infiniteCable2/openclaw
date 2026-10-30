import { isSessionBoundaryCommandText } from "../../auto-reply/command-detection.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { readRecentUserAssistantTextForSession } from "../../config/sessions/transcript.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";

/** Restore only explicit delivery context that the native model history excludes. */
export async function mergeSessionTranscriptContext(params: {
  agentId?: string;
  ctx: FinalizedMsgContext;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const options = params.ctx.SessionTranscriptContext;
  const limit = Math.max(0, Math.floor(options?.historyLimit ?? 0));
  if (
    !options?.chatWindow ||
    options.historyKind === "recent" ||
    limit === 0 ||
    isSessionBoundaryCommandText(params.ctx.CommandBody ?? params.ctx.RawBody, {
      botUsername: params.ctx.BotUsername,
    }) ||
    (params.ctx.ChannelStructuredContext ?? []).some(
      (entry) =>
        entry.type === "chat_window" &&
        entry.sessionTranscriptMode !== "preserve" &&
        Boolean(entry.payload) &&
        typeof entry.payload === "object" &&
        !Array.isArray(entry.payload),
    )
  ) {
    return;
  }
  // Channel history contains ambient messages, not an alternate copy of this
  // session's user/assistant turns. Native model history (including compaction)
  // owns those turns; replaying them here duplicates or resurrects old content.
  const agentId = params.agentId?.trim() || parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!agentId) {
    throw new Error("Session transcript context requires an agent owner.");
  }
  const turns = await readRecentUserAssistantTextForSession({
    agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    limit,
    includeCronDirectDeliveryContext: true,
    onlyCronDirectDeliveryContext: true,
    ...((options.beforeTimestampMs ?? params.ctx.Timestamp) !== undefined
      ? { beforeTimestampMs: options.beforeTimestampMs ?? params.ctx.Timestamp }
      : {}),
    ...(options.minTimestampMs !== undefined ? { minTimestampMs: options.minTimestampMs } : {}),
  });
  if (turns.length === 0) {
    return;
  }
  const labels = options.senderLabels ?? { assistant: "Assistant", user: "User" };
  params.ctx.ChannelStructuredContext = [
    ...(params.ctx.ChannelStructuredContext ?? []),
    {
      label: "Conversation context",
      source: "session",
      type: "chat_window",
      payload: {
        order: "chronological",
        relation: "selected_for_current_message",
        messages: turns.map((turn) => ({
          ...(turn.id ? { message_id: `session:${turn.id}` } : {}),
          sender: `${labels[turn.role]}${turn.sourceChannel ? ` (${turn.sourceChannel})` : ""}`,
          ...(turn.timestamp !== undefined ? { timestamp_ms: turn.timestamp } : {}),
          body: turn.text,
        })),
      },
    },
  ];
}
