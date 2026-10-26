import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import { createFreshLlmBoundaryTokenEstimator } from "../../sessions/context-token-pressure.js";
import { convertToLlm, type CustomMessage } from "../../sessions/messages.js";
import {
  createConversationContextCapacity,
  createPreparedConversationContextProjection,
} from "./prepared-conversation-context.js";

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const packet = (id: string, content = "Related conversation observation."): CustomMessage => ({
  role: "custom",
  customType: "test.related-conversation",
  content,
  display: false,
  details: { packetId: id },
  timestamp: 2,
});

describe("prepared conversation context projection", () => {
  it("preserves the dispatched prefix during live steering and native continuation", () => {
    const prompt = user("original request");
    const session = { agent: { state: { messages: [prompt] } } };
    const owner = createPreparedConversationContextProjection(session);
    expect(owner.project([prompt])).toEqual([prompt]);
    const first = packet("first");
    const second = packet("second");
    const boundary = owner.capture();
    const steering = user("additional request");
    session.agent.state.messages.push(steering);
    expect(owner.install([first, second], boundary)).toEqual([first, second]);
    expect(session.agent.state.messages).toEqual([prompt, first, second, steering]);
    const dispatched = [prompt, first, second];
    const reprojected = owner.project([prompt, steering]);
    expect(reprojected.slice(0, dispatched.length)).toEqual(dispatched);
    expect(reprojected.at(-1)).toBe(steering);
    expect(owner.project([...dispatched, steering])).toEqual(reprojected);
    expect(owner.install([{ ...first }], owner.capture())).toEqual([]);
  });

  it("does not resurrect packets after compaction removes their source boundary", () => {
    const prompt = user("original request");
    const session = { agent: { state: { messages: [prompt] } } };
    const owner = createPreparedConversationContextProjection(session);
    owner.project([prompt]);
    const old = packet("old");
    owner.install([old], owner.capture());
    session.agent.state.messages = [user("compacted history")];
    expect(owner.project(session.agent.state.messages)).toEqual(session.agent.state.messages);
    const stale = owner.capture();
    session.agent.state.messages = [user("replacement history")];
    expect(owner.install([packet("new")], stale)).toEqual([]);
    expect(session.agent.state.messages).toHaveLength(1);
  });

  it("does not modify source snapshots or duplicate reopened packet occurrences", () => {
    const prompt = user("original request");
    const stored = packet("stored");
    const source = [prompt];
    const session = { agent: { state: { messages: [...source] } } };
    const owner = createPreparedConversationContextProjection(session);
    owner.project(source);
    owner.install([stored], owner.capture());
    expect(source).toEqual([prompt]);
    const rehydrated = [prompt, { ...stored }];
    expect(owner.project(rehydrated)).toBe(rehydrated);
    // A finished request's projection must not retain another copy of native history.
    expect(owner.project(source)).toBe(source);
    expect(session.agent.state.messages).toEqual([prompt, stored]);
  });
});

describe("prepared conversation request capacity", () => {
  it("uses native request costs and reserves accepted additions cumulatively", () => {
    const messages = [user("current user input")];
    const systemPrompt = "Current system instructions";
    const tools = [{ name: "read", description: "Read a document", parameters: {} }];
    const estimate = createFreshLlmBoundaryTokenEstimator({ systemPrompt, tools });
    const first = packet("first", "A short observation.");
    const firstOnly = estimate({ messages: [...messages, ...convertToLlm([first])], prompt: "" });
    const reserveTokens = 64;
    const canAdmit = createConversationContextCapacity({
      messages,
      systemPrompt,
      tools,
      contextWindow: firstOnly + reserveTokens + 2,
      reserveTokens,
    });
    expect(canAdmit(packet("too-large", "x".repeat(2_000)))).toBe(false);
    expect(canAdmit(first)).toBe(true);
    expect(canAdmit(packet("second", "Another short observation."))).toBe(false);
    expect(messages).toEqual([user("current user input")]);
  });
});
