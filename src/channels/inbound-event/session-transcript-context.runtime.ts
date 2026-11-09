import { isSessionBoundaryCommandText } from "../../auto-reply/command-detection.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import {
  readRecentUserAssistantTextForSession,
  readRecentUserAssistantTurnsForSession,
} from "../../config/sessions/transcript.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";

/**
 * A platform-selected recent window keeps its own rows, except rows the model
 * already answered as user turns of this session: the conversation (and a
 * native runtime thread fed by it) holds them, so quoting them again on every
 * later turn only duplicates context. Only completed answers cover the preceding
 * request. Changed platform text and requests with incomplete output stay eligible.
 */
async function omitAnsweredRecentHistory(params: {
  agentId: string;
  ctx: FinalizedMsgContext;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const history = params.ctx.InboundHistory ?? [];
  let candidates = 0;
  for (const entry of history) {
    candidates += entry.messageId ? 1 : 0;
  }
  if (candidates === 0) {
    return;
  }
  // Roughly one user row and one reply per answered turn; a shorter read only keeps rows.
  const turns = await readRecentUserAssistantTurnsForSession({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    limit: candidates * 2,
    includeMessageToolSourceReplies: true,
  });
  // A reply proves only the user row right before it; earlier rows in the same gap
  // (a failed turn, or collected extras) stay, since a duplicate beats lost context.
  const answered = new Map<string, string>();
  let replied = false;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if (turn.role === "assistant") {
      replied ||= turn.isCompletedAnswer === true;
      continue;
    }
    if (replied && turn.messageId && !answered.has(turn.messageId)) {
      answered.set(turn.messageId, turn.text);
    }
    replied = false;
  }
  if (answered.size > 0) {
    params.ctx.InboundHistory = history.filter(
      // Text equality cannot prove that historical attachments are unchanged.
      (entry) =>
        !entry.messageId ||
        Boolean(entry.media?.length) ||
        answered.get(entry.messageId) !== entry.body.trim(),
    );
  }
}

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
  if (options?.historyKind === "recent") {
    if (agentId) {
      await omitAnsweredRecentHistory({ ...params, agentId });
    }
    return;
  }
  if (!options?.chatWindow) {
    return;
  }
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
        messages: turns.map((turn) => {
          const message: Record<string, unknown> = {};
          if (turn.id) {
            message.message_id = `session:${turn.id}`;
          }
          message.sender = `${labels[turn.role]}${turn.sourceChannel ? ` (${turn.sourceChannel})` : ""}`;
          if (turn.timestamp !== undefined) {
            message.timestamp_ms = turn.timestamp;
          }
          message.body = turn.text;
          return message;
        }),
      },
    },
  ];
}
