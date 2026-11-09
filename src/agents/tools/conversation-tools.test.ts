import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationListResultSchema,
  ConversationSendResultSchema,
  ConversationTurnResultSchema,
} from "../../../packages/gateway-protocol/src/schema/agent.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../../security/dangerous-tools.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { createHostedConversationTools } from "./conversation-tools.js";
import * as gateway from "./in-process-gateway.js";

const conversation = {
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  channel: "reef",
  accountId: "default",
  kind: "direct" as const,
  target: "reef:peer-agent",
  firstSeenAt: 100,
  lastSeenAt: 200,
};
const message = { conversationRef: conversation.conversationRef, message: "please acknowledge" };
const sent = {
  conversationRef: conversation.conversationRef,
  channel: "reef",
  messageId: "reef-outbound-1",
};
const operatorOptions = {
  sessionId: "operator-session",
  agentSessionKey: "agent:main:telegram:direct:operator",
  config: {},
};

function conversationTool(
  kind: "list" | "send" | "turn",
  options: Parameters<typeof createHostedConversationTools>[0] = {},
) {
  const tool = expectDefined(
    createHostedConversationTools(options, "main", {}).find(
      (entry) => entry.name === `conversations_${kind}`,
    ),
    "conversation tool",
  );
  expect(tool.outputSchema).toBe(
    {
      list: ConversationListResultSchema,
      send: ConversationSendResultSchema,
      turn: ConversationTurnResultSchema,
    }[kind],
  );
  expect(compactToolOutputHint(tool.outputSchema)).toBeDefined();
  return tool;
}

async function execute(
  kind: "list" | "send" | "turn",
  args: Record<string, unknown> = {},
  id: string = kind,
) {
  const tool = conversationTool(kind, operatorOptions);
  const result = await tool.execute(id, args);
  expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
  return result.details;
}

function mockGateway() {
  return vi.spyOn(gateway, "callAgentToolGatewayRequest").mockImplementation(async ({ method }) => {
    if (method === "conversations.list") {
      return { conversations: [conversation] };
    }
    if (method === "conversations.send") {
      return { status: "sent" as const, ...sent, queueId: "queue-1" };
    }
    return {
      status: "replied" as const,
      ...sent,
      correlationPersisted: true,
      reply: {
        conversationRef: conversation.conversationRef,
        messageId: "reef-inbound-1",
        replyToId: "reef-outbound-1",
        text: "peer acknowledged",
        timestamp: 300,
      },
    };
  });
}

describe("conversation tools", () => {
  afterEach(() => vi.restoreAllMocks());
  it("binds list context to the host session, not model-supplied arguments", async () => {
    const callGateway = mockGateway();
    const tool = conversationTool("list", {
      agentSessionKey: "agent:main:subagent:call:test",
      sessionId: "call-incarnation",
    });
    await tool.execute("list-origin", {
      sourceSessionKey: "agent:other:main",
      sourceSessionId: "forged",
    });
    expect(callGateway).toHaveBeenCalledWith({
      method: "conversations.list",
      params: {
        agentId: "main",
        limit: 50,
        sourceSessionKey: "agent:main:subagent:call:test",
        sourceSessionId: "call-incarnation",
      },
    });
    expect(Value.Check(tool.parameters, { sourceSessionKey: "agent:other:main" })).toBe(false);
  });

  it("does not guess a source incarnation when the host only supplies a key", async () => {
    const callGateway = mockGateway();
    await conversationTool("list", { agentSessionKey: "agent:main:main" }).execute("list", {});
    expect(callGateway).toHaveBeenCalledWith({
      method: "conversations.list",
      params: { agentId: "main", limit: 50 },
    });
  });

  it("lists opaque external addresses independently from sessions", async () => {
    const callGateway = mockGateway();
    const result = await execute("list", {
      channel: "reef",
      query: "@peer-agent",
    });
    expect(callGateway).toHaveBeenCalledWith({
      method: "conversations.list",
      params: {
        agentId: "main",
        channel: "reef",
        query: "@peer-agent",
        limit: 50,
        sourceSessionKey: operatorOptions.agentSessionKey,
        sourceSessionId: operatorOptions.sessionId,
      },
      config: {},
    });
    expect(result).toEqual({ conversations: [conversation] });
  });

  it("reports Gateway suppression without claiming delivery", async () => {
    const suppressed = {
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      queueId: "queue-suppressed",
    };
    mockGateway().mockResolvedValueOnce(suppressed);
    expect(await execute("send", message)).toEqual(suppressed);
  });

  it("keeps a transient Gateway send failure retryable under the stable tool call id", async () => {
    const callGateway = mockGateway();
    callGateway.mockRejectedValueOnce(new Error("gateway unavailable"));
    await expect(execute("send", message)).rejects.toThrow("gateway unavailable");
    await expect(execute("send", message)).resolves.toMatchObject({
      status: "sent",
      messageId: "reef-outbound-1",
      queueId: "queue-1",
    });
    const first = callGateway.mock.calls[0]![0];
    const second = callGateway.mock.calls[1]![0];
    expect(second).toMatchObject({
      method: "conversations.send",
      params: {
        agentId: "main",
        sourceSessionKey: operatorOptions.agentSessionKey,
        ...message,
        operationId: expect.stringMatching(/^convop_[a-f0-9]{32}$/u),
      },
      config: {},
    });
    expect(second.params).toEqual(first.params);
  });

  it("uses a stable operation id for correlated turns and cancels on abort", async () => {
    const callGateway = mockGateway();
    await execute("turn", { ...message, timeoutSeconds: 12 });
    await execute("turn", { ...message, timeoutSeconds: 12 });
    const first = callGateway.mock.calls[0]![0];
    const second = callGateway.mock.calls[1]![0];
    expect(first.params).toMatchObject({ turnId: expect.stringMatching(/^convop_[a-f0-9]{32}$/u) });
    expect(second.params).toEqual(first.params);
    const request = vi.fn().mockResolvedValue({ cancelled: true });
    await first.onSignalAbort?.(request);
    expect(request).toHaveBeenCalledWith(
      "conversations.turn.cancel",
      { agentId: "main", turnId: expect.any(String) },
      { timeoutMs: 5_000 },
    );
    expect(first.params).toMatchObject(request.mock.calls[0]?.[1]);
  });

  it("validates references and owner access before Gateway delivery", async () => {
    const callGateway = mockGateway();
    await expect(
      conversationTool("send", { config: {} }).execute("send", {
        conversationRef: "not-a-conversation",
        message: "hello",
      }),
    ).rejects.toThrow("Invalid conversationRef");
    for (const kind of ["list", "send", "turn"] as const) {
      const tool = conversationTool(kind, { senderIsOwner: false, config: {} });
      await expect(tool.execute("blocked", message)).rejects.toThrow("require owner access");
    }
    expect(callGateway).not.toHaveBeenCalled();
    for (const name of ["conversations_list", "conversations_send", "conversations_turn"]) {
      expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain(name);
      expect(DEFAULT_GATEWAY_HTTP_TOOL_DENY).toContain(name);
    }
  });
});
