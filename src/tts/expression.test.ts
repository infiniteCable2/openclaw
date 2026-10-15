import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertSpeechExpressionSupported,
  isSpeechExpressionEnabled,
  parseSpeechExpression,
} from "./expression.js";

const plan = {
  emotion: "joyful",
  parts: [{ text: "Hello " }, { event: "laugh" }, { text: "there.", emphasis: true }],
};
const capabilities = {
  emotions: ["joyful"],
  vocalEvents: ["laugh"],
  emphasis: true,
  whisper: false,
};

describe("structured speech expression admission", () => {
  it("keeps plain text exact and provider controls separate", () => {
    const admitted = parseSpeechExpression(plan, "Hello there.");
    expect(admitted).toEqual(plan);
    expect(admitted).not.toBe(plan);
    expect(() => assertSpeechExpressionSupported(admitted, capabilities)).not.toThrow();
  });

  it.each([
    { parts: [] },
    { parts: [{ event: "laugh" }] },
    { parts: [{ text: "Different." }] },
    { parts: [{ text: "Hello there.", event: "laugh" }] },
    { parts: [{ text: "Hello there.", emphasis: "yes" }] },
    { parts: [{ text: "Hello there.", hidden: true }] },
    { emotion: "[joyful]", parts: [{ text: "Hello there." }] },
    { parts: [{ text: "Hello there." }], unknown: true },
    { parts: Array.from({ length: 129 }, () => ({ text: "x" })) },
    {
      parts: [{ text: "Hello there." }, ...Array.from({ length: 65 }, () => ({ event: "laugh" }))],
    },
  ])("rejects malformed or non-projecting expression %j", (value) => {
    expect(() => parseSpeechExpression(value, "Hello there.")).toThrow();
  });

  it("rejects text/emphasis budgets", () => {
    const text = "x".repeat(81);
    expect(() => parseSpeechExpression({ parts: [{ text, emphasis: true }] }, text)).toThrow();
    const oversized = "x".repeat(16_385);
    expect(() => parseSpeechExpression({ parts: [{ text: oversized }] }, oversized)).toThrow();
  });

  it("admits supported emotion changes without changing the plain projection", () => {
    const changing = {
      emotion: "joyful",
      parts: [
        { text: "Hello. " },
        { text: "A quiet moment. ", emotion: "tender" },
        { text: "Still here." },
      ],
    };
    const admitted = parseSpeechExpression(changing, "Hello. A quiet moment. Still here.");
    expect(admitted).toEqual(changing);
    expect(() => assertSpeechExpressionSupported(admitted, capabilities)).toThrow("emotion");
    expect(() =>
      assertSpeechExpressionSupported(admitted, {
        ...capabilities,
        emotions: ["joyful", "tender"],
      }),
    ).not.toThrow();
    expect(() =>
      parseSpeechExpression({ parts: [{ text: "Hello.", emotion: "[joyful]" }] }, "Hello."),
    ).toThrow();
  });

  it("counts part-level emotion declarations against the shared control budget", () => {
    const parts = Array.from({ length: 65 }, () => ({ text: "Hi. ", emotion: "joyful" }));
    expect(() => parseSpeechExpression({ parts }, parts.map((part) => part.text).join(""))).toThrow(
      "budget",
    );
  });

  it.each([
    undefined,
    { ...capabilities, emotions: [] },
    { ...capabilities, vocalEvents: [] },
    { ...capabilities, emphasis: false },
  ])("refuses unsupported declarations without neutral fallback", (providerCapabilities) => {
    expect(() => assertSpeechExpressionSupported(plan, providerCapabilities)).toThrow();
  });

  it("does not treat whisper availability as an arbitrary event or emotion permission", () => {
    expect(() =>
      assertSpeechExpressionSupported(
        { emotion: "whisper", parts: [{ text: "Hello." }] },
        { ...capabilities, whisper: true },
      ),
    ).toThrow();
  });
});

describe("agent/channel/target speech expression policy", () => {
  const cfg: OpenClawConfig = {
    talk: {
      speech: {
        agentProfiles: {
          reader: { expression: { channels: { matrix: { targets: ["voice-note"] } } } },
          another: {},
        },
      },
    },
  };

  it("allows only the exact configured scope", () => {
    expect(
      isSpeechExpressionEnabled({
        cfg,
        agentId: "reader",
        channelId: "matrix",
        target: "voice-note",
      }),
    ).toBe(true);
  });
  it.each([
    { agentId: "another", channelId: "matrix", target: "voice-note" as const },
    { agentId: "reader", channelId: "other", target: "voice-note" as const },
    { agentId: "reader", channelId: "matrix", target: "telephony" as const },
    { agentId: undefined, channelId: "matrix", target: "voice-note" as const },
    { agentId: "reader", channelId: undefined, target: "voice-note" as const },
    { agentId: "constructor", channelId: "matrix", target: "voice-note" as const },
  ])("does not inherit expressions for %j", (context) => {
    expect(isSpeechExpressionEnabled({ cfg, ...context })).toBe(false);
  });
});
