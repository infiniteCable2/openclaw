import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { readRecentUserAssistantTextForSession } from "../../config/sessions/transcript.js";
import { runPreparedChannelTurn } from "../turn/execution.js";
import { mergeSessionTranscriptContext } from "./session-transcript-context.runtime.js";

// mock-isolation: This channel fixture keeps native database state outside its dispatch boundary.
vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(),
}));

const readRecent = vi.mocked(readRecentUserAssistantTextForSession);

function context(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "continue",
    RawBody: "continue",
    CommandBody: "continue",
    From: "slack:channel:C1",
    To: "channel:C1",
    SessionKey: "agent:main:slack:channel:c1",
    AgentId: "main",
    Provider: "slack",
    Timestamp: 4_000,
    CommandAuthorized: false,
    SessionTranscriptContext: { historyLimit: 3 },
    ...overrides,
  };
}

async function merge(ctx: FinalizedMsgContext) {
  await mergeSessionTranscriptContext({
    ctx,
    sessionKey: ctx.SessionKey!,
    storePath: "/tmp/sessions.json",
  });
}

describe("session transcript inbound context", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    readRecent.mockReset();
  });

  it("leaves ambient pending messages intact without copying native model history", async () => {
    const history = [
      { sender: "Alice", body: "unaddressed discussion", timestamp: 1_000, messageId: "ambient" },
    ];
    const ctx = context({ InboundHistory: history });
    const dispatch = vi.fn(async () => ({ queuedFinal: false }));
    await runPreparedChannelTurn({
      channel: "slack",
      routeSessionKey: ctx.SessionKey!,
      storePath: path.join(tempDirs.make("openclaw-session-transcript-context-"), "sessions.json"),
      ctxPayload: ctx,
      recordInboundSession: vi.fn(async () => undefined),
      runDispatch: dispatch,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(ctx.InboundHistory).toBe(history);
    expect(readRecent).not.toHaveBeenCalled();
    expect(buildInboundUserContextPrefix(ctx)).toContain("unaddressed discussion");
  });

  it("preserves a configured platform-selected recent window without restoring transcript rows", async () => {
    const ctx = context({
      ChatType: "channel",
      SessionTranscriptContext: { historyLimit: 50, historyKind: "recent" },
      InboundHistory: Array.from({ length: 55 }, (_, index) => ({
        sender: "Alice",
        body: `native-line-${String(index).padStart(2, "0")}`,
        timestamp: index,
      })),
    });
    await merge(ctx);
    expect(buildInboundUserContextPrefix(ctx).match(/native-line-\d{2}/g)).toEqual(
      Array.from({ length: 50 }, (_, index) => `native-line-${String(index + 5).padStart(2, "0")}`),
    );
    expect(readRecent).not.toHaveBeenCalled();
  });

  it("restores only explicitly marked non-model Cron delivery context without a live window", async () => {
    readRecent.mockResolvedValue([
      { id: "cron-1", role: "assistant", text: "scheduled payload", timestamp: 2_000 },
    ]);
    const ctx = context({
      InboundHistory: [{ messageId: "pending", sender: "Alice", body: "ambient pending" }],
      SessionTranscriptContext: {
        chatWindow: true,
        historyLimit: 3,
        beforeTimestampMs: 3_000,
        minTimestampMs: 1_000,
        senderLabels: { assistant: "OpenClaw", user: "User" },
      },
    });
    await merge(ctx);
    expect(readRecent).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      sessionKey: ctx.SessionKey,
      storePath: "/tmp/sessions.json",
      limit: 3,
      includeCronDirectDeliveryContext: true,
      onlyCronDirectDeliveryContext: true,
      beforeTimestampMs: 3_000,
      minTimestampMs: 1_000,
    });
    expect(ctx.InboundHistory?.[0]?.body).toBe("ambient pending");
    expect(ctx.ChannelStructuredContext).toEqual([
      {
        label: "Conversation context",
        source: "session",
        type: "chat_window",
        payload: {
          order: "chronological",
          relation: "selected_for_current_message",
          messages: [
            {
              message_id: "session:cron-1",
              sender: "OpenClaw",
              timestamp_ms: 2_000,
              body: "scheduled payload",
            },
          ],
        },
      },
    ]);
  });

  it("preserves the complete live window and reply target without reading canonical turns", async () => {
    const windows = [
      {
        label: "Conversation context",
        source: "telegram",
        type: "chat_window",
        payload: {
          messages: [
            { message_id: "target", body: "reply target", is_reply_target: true },
            { message_id: "ambient", body: "new discussion" },
          ],
        },
      },
    ];
    const ctx = context({
      SessionTranscriptContext: { chatWindow: true, historyLimit: 2 },
      ChannelStructuredContext: windows,
    });
    await merge(ctx);
    expect(ctx.ChannelStructuredContext).toBe(windows);
    expect(readRecent).not.toHaveBeenCalled();
  });

  it("preserves independent thread history while adding only a missing delivery window", async () => {
    const thread = {
      label: "Thread history",
      source: "msteams",
      type: "chat_window",
      sessionTranscriptMode: "preserve" as const,
      payload: { messages: [{ message_id: "parent", body: "thread parent" }] },
    };
    readRecent.mockResolvedValue([
      { id: "cron", role: "assistant", text: "scheduled result", timestamp: 2_000 },
    ]);
    const ctx = context({
      SessionTranscriptContext: { chatWindow: true, historyLimit: 2 },
      ChannelStructuredContext: [thread],
    });
    await merge(ctx);
    expect(ctx.ChannelStructuredContext?.[0]).toBe(thread);
    expect(ctx.ChannelStructuredContext).toHaveLength(2);
    const prompt = buildInboundUserContextPrefix(ctx);
    expect(prompt).toContain("thread parent");
    expect(prompt).toContain("scheduled result");
  });

  it("fails closed for an unscoped delivery-context read without a routed owner", async () => {
    const ctx = context({
      AgentId: undefined,
      SessionKey: "slack:channel:c1",
      SessionTranscriptContext: { chatWindow: true, historyLimit: 3 },
    });
    await expect(merge(ctx)).rejects.toThrow("Session transcript context requires an agent owner.");
    expect(readRecent).not.toHaveBeenCalled();
  });

  it.each([0, 3])(
    "does not restore delivery context for a session boundary (limit=%i)",
    async (limit) => {
      await merge(
        context({
          CommandBody: "/new summarize this workspace",
          SessionTranscriptContext: { chatWindow: true, historyLimit: limit },
        }),
      );
      expect(readRecent).not.toHaveBeenCalled();
    },
  );

  it("leaves context unchanged when no classified delivery rows exist", async () => {
    readRecent.mockResolvedValue([]);
    const ctx = context({ SessionTranscriptContext: { chatWindow: true, historyLimit: 3 } });
    await merge(ctx);
    expect(ctx.ChannelStructuredContext).toBeUndefined();
    expect(ctx.InboundHistory).toBeUndefined();
  });
});
