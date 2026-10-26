import { describe, expect, it } from "vitest";
import {
  readConversationObservationRole,
  transcriptRewritePreservesConversationObservation,
} from "./conversation-observation.js";

describe("original committed dialogue selection", () => {
  it.each([undefined, { kind: "external_user" }])(
    "accepts direct input with provenance %j",
    (provenance) => {
      expect(
        readConversationObservationRole({ role: "user", content: "A new request.", provenance }),
      ).toBe("user");
    },
  );

  it("accepts commentary while leaving action completion unclaimed", () => {
    expect(
      readConversationObservationRole({
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "I am checking." },
          { type: "toolCall", arguments: {} },
        ],
        __openclaw: { runId: "run-example" },
      }),
    ).toBe("assistant");
  });

  it.each([
    { role: "user", content: "Imported.", provenance: { kind: "inter_session" } },
    { role: "user", content: "Internal.", provenance: { kind: "internal_system" } },
    { role: "user", content: "Hidden.", display: false },
    { role: "user", content: "Excluded.", excludeFromContext: true },
    { role: "user", content: "Blocked.", __openclaw: { beforeAgentRunBlocked: true } },
    { role: "toolResult", content: "Not dialogue." },
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "thinking", thinking: "Private." }],
      __openclaw: { runId: "example" },
    },
    {
      role: "assistant",
      stopReason: "error",
      content: "Failed.",
      __openclaw: { runId: "example" },
    },
    { role: "assistant", stopReason: "stop", content: "No native run." },
  ])("rejects non-original or unfinished payload %j", (message) => {
    expect(readConversationObservationRole(message)).toBeUndefined();
  });
});

describe("exact native operational annotation continuity", () => {
  const original = {
    type: "message",
    id: "input",
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    message: {
      role: "user",
      content: "Original utterance.",
      idempotencyKey: "original-input",
      provenance: { kind: "external_user" },
      timestamp: 1,
      __openclaw: { runId: "original-run" },
    },
  };
  const annotated = {
    ...original,
    message: {
      ...original.message,
      __openclaw: {
        ...original.message.__openclaw,
        modelPromptProjection: { version: 1, text: "Derived model input." },
        steerTargetRunId: "target-run",
      },
    },
  };
  const preserves = (next: unknown) =>
    transcriptRewritePreservesConversationObservation(
      JSON.stringify(original),
      JSON.stringify(next),
    );
  it("preserves only named annotations, leaving original body and provenance intact", () => {
    expect(preserves(annotated)).toBe(true);
  });
  it.each([
    { content: "Changed text." },
    { idempotencyKey: "other-input" },
    { provenance: { kind: "internal_system" } },
    { role: "assistant" },
    { timestamp: 2 },
    { __openclaw: { ...annotated.message.__openclaw, runId: "other-run" } },
    { __openclaw: { ...annotated.message.__openclaw, beforeAgentRunBlocked: true } },
    { media: ["changed-media"] },
  ])("refuses other source changes %j", (patch) => {
    expect(preserves({ ...annotated, message: { ...annotated.message, ...patch } })).toBe(false);
  });
  it("does not renew a changed event envelope", () => {
    expect(preserves({ ...annotated, parentId: "other-parent" })).toBe(false);
    expect(preserves({ ...annotated, timestamp: "2026-01-02T00:00:00Z" })).toBe(false);
  });
});
