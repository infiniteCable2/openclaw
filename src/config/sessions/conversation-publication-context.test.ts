import { describe, expect, it, vi } from "vitest";
import {
  captureConversationPublication,
  captureConversationPublicationAppend,
  captureSerializedConversationPublication,
  withConversationPublicationContext,
} from "./conversation-publication-context.js";
import type { ConversationPublicationIntent } from "./conversation-publication.types.js";

const source = { agentId: "example", sessionKey: "agent:example:branch", sessionId: "session-a" };
const intent: ConversationPublicationIntent = {
  version: 1,
  kind: "utterance-observation",
  role: "assistant",
  sourceMode: "branches",
  runId: "run-a",
  source: {
    sessionKey: source.sessionKey,
    sessionId: source.sessionId,
    lifecycleRevision: "life-a",
  },
  root: { sessionKey: "agent:example:root", sessionId: "root-a", lifecycleRevision: "root-life" },
};
const message = {
  role: "assistant",
  content: "A saved answer.",
  stopReason: "stop",
  __openclaw: { runId: "run-a" },
};

describe("host publication context", () => {
  it("decodes serialized messages only for their exact live publication owner", () => {
    const payloads = [512, 32_768, 262_144].map((size) =>
      JSON.stringify({ ...message, content: "x".repeat(size) }),
    );
    const parse = vi.spyOn(JSON, "parse");
    try {
      for (const payload of payloads) {
        expect(captureSerializedConversationPublication(source, payload)).toBeUndefined();
      }
      expect(parse).not.toHaveBeenCalled();
      withConversationPublicationContext(
        { source, runId: "run-a", capture: () => ({ intent, assertCurrent() {} }) },
        () => {
          for (const payload of payloads) {
            for (const foreign of [
              { ...source, agentId: "other-agent" },
              { ...source, sessionKey: "agent:example:other" },
              { ...source, sessionId: "other-incarnation" },
            ]) {
              expect(captureSerializedConversationPublication(foreign, payload)).toBeUndefined();
            }
            const before = parse.mock.calls.length;
            expect(captureSerializedConversationPublication(source, payload)?.intent).toEqual(
              intent,
            );
            expect(parse.mock.calls.length - before).toBe(1);
          }
        },
      );
      expect(parse).toHaveBeenCalledTimes(payloads.length);
    } finally {
      parse.mockRestore();
    }
  });

  it("does not recapture a top-level append after its lock admission awaits", async () => {
    const capture = vi.fn(() => ({ intent, assertCurrent() {} }));
    await withConversationPublicationContext({ source, runId: "run-a", capture }, async () => {
      const original = { message };
      const captured = captureConversationPublicationAppend(source, original);
      await Promise.resolve();
      expect(captureConversationPublicationAppend(source, captured)).toBe(captured);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(original).not.toHaveProperty("conversationPublication");
    });
  });

  it("carries immutable original provenance across async execution but not outside the owner", async () => {
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("Original source retired");
      }
    };
    const captured = await withConversationPublicationContext(
      { source, runId: "run-a", capture: () => ({ intent, assertCurrent }) },
      async () => {
        await Promise.resolve();
        return captureConversationPublication(source, message);
      },
    );
    expect(captured?.intent).toEqual(intent);
    expect(captured?.intent).not.toBe(intent);
    expect(captureConversationPublication(source, message)).toBeUndefined();
    current = false;
    expect(() => captured?.assertCurrent()).toThrow("Original source retired");
  });

  it("does not label failed, hidden, reflected, foreign-source or foreign-run messages", () => {
    withConversationPublicationContext(
      { source, runId: "run-a", capture: () => ({ intent, assertCurrent() {} }) },
      () => {
        for (const invalid of [
          { ...message, role: "user" },
          { ...message, stopReason: "error" },
          { ...message, display: false },
          { ...message, excludeFromContext: true },
          { ...message, content: [{ type: "thinking", thinking: "Private reasoning." }] },
          { ...message, role: "custom", customType: "openclaw.conversation-context" },
          { ...message, provenance: { kind: "inter_session" } },
          { ...message, __openclaw: { runId: "other-run" } },
        ]) {
          expect(captureConversationPublication(source, invalid)).toBeUndefined();
        }
        expect(
          captureConversationPublication({ ...source, sessionId: "new-incarnation" }, message),
        ).toBeUndefined();
        expect(
          captureConversationPublication({ ...source, agentId: "other-agent" }, message),
        ).toBeUndefined();
      },
    );
  });

  it("captures saved commentary before final completion without publishing tool arguments", () => {
    withConversationPublicationContext(
      { source, runId: "run-a", capture: () => ({ intent, assertCurrent() {} }) },
      () => {
        const commentary = {
          ...message,
          stopReason: "toolUse",
          endTurn: false,
          content: [
            { type: "text", text: "I will check that." },
            { type: "toolCall", id: "call-a", name: "example", arguments: { private: "data" } },
          ],
        };
        expect(captureConversationPublication(source, commentary)?.intent).toEqual(intent);
        expect(
          captureConversationPublication(source, {
            ...commentary,
            content: [commentary.content[1]],
          }),
        ).toBeUndefined();
      },
    );
  });
});
