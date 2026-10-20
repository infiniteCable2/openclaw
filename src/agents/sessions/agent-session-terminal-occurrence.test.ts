import { expect, it } from "vitest";
import { subscribeEmbeddedAgentSession } from "../embedded-agent-subscribe.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

it("retains the committed native terminal entry, not an earlier identical answer", async () => {
  const message = createAssistant(testModel, [{ type: "text", text: "The colour is blue." }]);
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "An earlier question.", timestamp: 1 });
  const previous = manager.appendMessage({ ...message });
  streamMocks.streamSimple.mockImplementation(() => createAssistantResultStream({ ...message }));
  const { session } = await createTestSession({ sessionManager: manager });
  const subscription = subscribeEmbeddedAgentSession({ session, runId: "native-run" });
  try {
    await session.prompt("Remember the colour blue.");
    const terminal = manager.getLeafEntry();
    expect(terminal?.type).toBe("message");
    expect(subscription.getAssistantTranscriptEntryId()).toBe(terminal?.id);
    expect(subscription.getAssistantTranscriptEntryId()).not.toBe(previous);
    if (terminal?.type !== "message") {
      throw new Error("Expected the native committed assistant");
    }
    expect(terminal.message).not.toHaveProperty("idempotencyKey");
  } finally {
    subscription.unsubscribe();
  }
});
