import { expect, it } from "vitest";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

it.each(["native", "legacy"] as const)(
  "completes a detached greeting with %s speech facts and an immutable transcript",
  async (format) => {
    const text = "Good morning!";
    const expression = { emotion: "joyful", parts: [{ text }] };
    const message = createAssistant(testModel, [
      format === "native"
        ? {
            type: "text",
            text,
            openclawDelivery: { tts: { tagged: true, text, expression } },
          }
        : { type: "text", text: `[[tts:voice=example]]${text}` },
    ]);
    streamMocks.streamSimple.mockImplementation(() => createAssistantResultStream(message));
    // Greeting generation owns a detached manager, not the caller's durable writer.
    const manager = SessionManager.inMemory();
    const { session } = await createTestSession({ sessionManager: manager });
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.prompt("Prepare one short greeting only.");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(session.agent.state.isStreaming).toBe(false);
    const leaf = manager.getLeafEntry();
    expect(leaf).toMatchObject({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        openclawDelivery: { tts: { tagged: true, ...(format === "native" ? { expression } : {}) } },
      },
    });
    expect(Object.isFrozen(leaf)).toBe(true);
    if (leaf?.type !== "message" || leaf.message.role !== "assistant") {
      throw new Error("Greeting was not recorded as an assistant message");
    }
    expect(Object.isFrozen(leaf.message)).toBe(true);
    expect(Object.isFrozen(leaf.message.content)).toBe(true);
    expect(manager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
    expect(
      events.some(
        (event) =>
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.stopReason === "error",
      ),
    ).toBe(false);
  },
);

it("retains keyed user replay in a detached manager", async () => {
  const manager = SessionManager.inMemory();
  const user = {
    role: "user" as const,
    content: "Hello",
    timestamp: 1,
    idempotencyKey: "one-input",
  };
  const first = await manager.appendMessageAsync(user);
  expect(await manager.appendMessageAsync({ ...user })).toBe(first);
  expect(manager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(1);
});

it("still rejects invalid native speech before appending a detached assistant", async () => {
  const manager = SessionManager.inMemory();
  const message = createAssistant(testModel, [
    {
      type: "text",
      text: "Hello.",
      openclawDelivery: {
        tts: { tagged: true, text: "Hello.", expression: { parts: [{ text: "Different." }] } },
      },
    },
  ]);
  await expect(manager.appendMessageAsync(message)).rejects.toThrow("project exactly");
  expect(manager.getEntries()).toHaveLength(0);
});
