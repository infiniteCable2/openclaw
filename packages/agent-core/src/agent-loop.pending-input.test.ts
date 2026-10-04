import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runAgentLoop } from "./agent-loop.js";
import { Agent } from "./agent.js";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
} from "./llm.js";
import type { AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const convertToLlm = (messages: AgentMessage[]) => messages as Message[];

function response(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 2,
  };
}

function fixture(responses: AssistantMessage[]) {
  const contexts: Message[][] = [];
  const streamFn: StreamFn = (_model, context) => {
    contexts.push([...context.messages]);
    const message = responses.shift();
    if (!message) {
      throw new Error("Unexpected provider continuation");
    }
    const stream = createAssistantMessageEventStream();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: message.stopReason, message });
    }
    return stream;
  };
  return { contexts, streamFn };
}

describe("native pending-input completion boundary", () => {
  it("publishes terminal state before yielding after the synchronous idle decision", async () => {
    const { streamFn } = fixture([response([{ type: "text", text: "A" }])]);
    let terminalSeen = false;
    let terminalSeenAtNextMicrotask = false;
    await runAgentLoop(
      [user("A")],
      { systemPrompt: "", messages: [] },
      {
        model,
        convertToLlm,
        waitForPendingInput: () => {
          queueMicrotask(() => {
            terminalSeenAtNextMicrotask = terminalSeen;
          });
        },
      },
      (event) => {
        if (event.type === "agent_end") {
          terminalSeen = true;
        }
      },
      undefined,
      streamFn,
    );
    expect(terminalSeenAtNextMicrotask).toBe(true);
  });

  it("adopts delayed input in the same Agent run without replaying completed tools", async () => {
    const entered = createDeferred();
    const pending = createDeferred();
    let acquiring = true;
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "A result" }],
      details: {},
    }));
    const { contexts, streamFn } = fixture([
      response([{ type: "toolCall", id: "tool-a", name: "check", arguments: {} }], "toolUse"),
      response([{ type: "text", text: "A answer" }]),
      response([{ type: "text", text: "A and B answer" }]),
    ]);
    const events: AgentEvent[] = [];
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            name: "check",
            label: "Check",
            description: "Check",
            parameters: Type.Object({}),
            execute,
          },
        ],
      },
      streamFn,
      convertToLlm,
      waitForPendingInput: () => {
        if (!acquiring) {
          return undefined;
        }
        entered.resolve();
        return pending.promise;
      },
    });
    agent.subscribe((event) => {
      events.push(event);
    });
    const run = agent.prompt("A");
    await entered.promise;
    expect(agent.state.isStreaming).toBe(true);
    expect(events.some((event) => event.type === "agent_end")).toBe(false);
    expect(contexts).toHaveLength(2);
    agent.steer(user("B"));
    acquiring = false;
    pending.resolve();
    await run;
    expect(contexts).toHaveLength(3);
    expect(contexts[2]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "toolResult", toolCallId: "tool-a" }),
        expect.objectContaining({ role: "user", content: "B" }),
      ]),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
  });

  it("rechecks acquisition that starts during the final asynchronous queue drain", async () => {
    const entered = createDeferred();
    const pending = createDeferred();
    let acquiring = false;
    let drains = 0;
    const queue: AgentMessage[] = [];
    const { contexts, streamFn } = fixture([
      response([{ type: "text", text: "A" }]),
      response([{ type: "text", text: "A plus B" }]),
    ]);
    const events: AgentEvent[] = [];
    const run = runAgentLoop(
      [user("A")],
      { systemPrompt: "", messages: [] },
      {
        model,
        convertToLlm,
        getFollowUpMessages: async () => {
          if (++drains === 1) {
            acquiring = true;
          }
          return queue.splice(0);
        },
        waitForPendingInput: () => {
          if (acquiring) {
            entered.resolve();
            return pending.promise;
          }
          return undefined;
        },
      },
      (event) => {
        events.push(event);
      },
      undefined,
      streamFn,
    );
    await entered.promise;
    expect(events.some((event) => event.type === "agent_end")).toBe(false);
    queue.push(user("B"));
    acquiring = false;
    pending.resolve();
    await run;
    expect(contexts).toHaveLength(2);
    expect(contexts[1]).toContainEqual(user("B"));
  });

  it("releases a rejected candidate without another model request", async () => {
    const entered = createDeferred();
    const pending = createDeferred();
    let acquiring = true;
    const { contexts, streamFn } = fixture([response([{ type: "text", text: "A" }])]);
    const agent = new Agent({
      initialState: { model },
      streamFn,
      waitForPendingInput: () => {
        if (acquiring) {
          entered.resolve();
          return pending.promise;
        }
        return undefined;
      },
    });
    const run = agent.prompt("A");
    await entered.promise;
    acquiring = false;
    pending.resolve();
    await run;
    expect(contexts).toHaveLength(1);
    expect(agent.state.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "A" }] });
  });

  it("aborts a stuck producer without waiting or issuing another model request", async () => {
    const entered = createDeferred();
    const pending = createDeferred();
    const { contexts, streamFn } = fixture([response([{ type: "text", text: "A" }])]);
    let receivedSignal: AbortSignal | undefined;
    const events: AgentEvent[] = [];
    const agent = new Agent({
      initialState: { model },
      streamFn,
      waitForPendingInput: (signal) => {
        receivedSignal = signal;
        entered.resolve();
        return pending.promise;
      },
    });
    agent.subscribe((event) => {
      events.push(event);
    });
    const run = agent.prompt("A");
    await entered.promise;
    agent.abort();
    await run;
    expect(receivedSignal?.aborted).toBe(true);
    expect(agent.state.isStreaming).toBe(false);
    expect(contexts).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    pending.reject(new Error("Late producer failure"));
  });

  it.each(["immediate", "late"] as const)(
    "observes a %s producer rejection when acquisition aborts synchronously",
    async (timing) => {
      const pending = createDeferred();
      const { contexts, streamFn } = fixture([response([{ type: "text", text: "A" }])]);
      const events: AgentEvent[] = [];
      const agent = new Agent({
        initialState: { model },
        streamFn,
        waitForPendingInput: () => {
          agent.abort();
          if (timing === "immediate") {
            pending.reject(new Error("Producer stopped"));
          }
          return pending.promise;
        },
      });
      agent.subscribe((event) => {
        events.push(event);
      });
      await agent.prompt("A");
      if (timing === "late") {
        pending.reject(new Error("Late producer stop"));
      }
      expect(contexts).toHaveLength(1);
      expect(agent.state.isStreaming).toBe(false);
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    },
  );

  it.each(["steer", "followUp"] as const)(
    "processes already queued %s before the completion barrier",
    async (mode) => {
      const { contexts, streamFn } = fixture([
        response([{ type: "text", text: "A" }]),
        response([{ type: "text", text: "B" }]),
      ]);
      const barrier = vi.fn(() => {
        expect(contexts).toHaveLength(2);
      });
      const agent = new Agent({ initialState: { model }, streamFn, waitForPendingInput: barrier });
      let queued = false;
      agent.subscribe((event) => {
        if (event.type === "turn_end" && !queued) {
          queued = true;
          agent[mode](user("B"));
        }
      });
      await agent.prompt("A");
      expect(barrier).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["error", "stop"] as const)("bypasses the barrier for terminal %s", async (kind) => {
    const { streamFn } = fixture([
      response([{ type: "text", text: "A" }], kind === "error" ? "error" : "stop"),
    ]);
    const barrier = vi.fn();
    const config: AgentLoopConfig = {
      model,
      convertToLlm,
      waitForPendingInput: barrier,
      shouldStopAfterTurn: () => kind === "stop",
    };
    await runAgentLoop(
      [user("A")],
      { systemPrompt: "", messages: [] },
      config,
      () => {},
      undefined,
      streamFn,
    );
    expect(barrier).not.toHaveBeenCalled();
  });
});
