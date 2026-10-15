import { describe, expect, it } from "vitest";
import type {
  AssistantDeliveryTtsFacts,
  AssistantMessage,
  SpeechExpression,
  TextContent,
} from "../llm/types.js";
import {
  collectNativeSpeechPresentation,
  sliceNativeSpeechPresentation,
} from "./speech-presentation-facts.js";

function block(
  text: string,
  expression?: SpeechExpression,
  phase?: "commentary" | "final_answer",
): TextContent {
  return {
    type: "text",
    text,
    openclawDelivery: { tts: { tagged: true, text, ...(expression ? { expression } : {}) } },
    ...(phase ? { textSignature: JSON.stringify({ v: 1, phase }) } : {}),
  };
}

function message(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

describe("collect native speech presentation facts", () => {
  it("does not infer speech metadata for ordinary text", () => {
    expect(
      collectNativeSpeechPresentation(message([{ type: "text", text: "Hello." }])),
    ).toBeUndefined();
  });

  it("includes plain siblings and uses the shared newline projection", () => {
    expect(
      collectNativeSpeechPresentation(
        message([{ type: "text", text: "First." }, block("Second."), { type: "text", text: " " }]),
      ),
    ).toEqual({ tagged: true, text: "First.\nSecond." });
  });

  it("collects exactly one explicit phase and never mixes in unphased text", () => {
    const value = message([
      block("Working.", { emotion: "focused", parts: [{ text: "Working." }] }, "commentary"),
      block("Done.", undefined, "final_answer"),
      block("Legacy."),
    ]);
    expect(collectNativeSpeechPresentation(value)).toEqual({ tagged: true, text: "Done." });
    expect(collectNativeSpeechPresentation(value, "commentary")).toEqual({
      tagged: true,
      text: "Working.",
      expression: { emotion: "focused", parts: [{ text: "Working." }] },
    });
  });

  it("permits unphased fallback only for final answers", () => {
    const value = message([block("Legacy.")]);
    expect(collectNativeSpeechPresentation(value)).toEqual({ tagged: true, text: "Legacy." });
    expect(collectNativeSpeechPresentation(value, "commentary")).toBeUndefined();
    expect(
      collectNativeSpeechPresentation(message([block("Working.", undefined, "commentary")])),
    ).toBeUndefined();
  });

  it("honors the shared top-level phase for unphased blocks", () => {
    const value = Object.assign(message([block("Working.")]), { phase: "commentary" });
    expect(collectNativeSpeechPresentation(value)).toBeUndefined();
    expect(collectNativeSpeechPresentation(value, "commentary")).toEqual({
      tagged: true,
      text: "Working.",
    });
  });

  it("preserves emotion scope across plain blocks and later explicit changes", () => {
    expect(
      collectNativeSpeechPresentation(
        message([
          block("Hello.", { emotion: "joyful", parts: [{ text: "Hello." }] }),
          { type: "text", text: "Still happy." },
          block("Quiet.", { parts: [{ text: "Quiet.", emotion: "tender" }] }),
        ]),
      ),
    ).toEqual({
      tagged: true,
      text: "Hello.\nStill happy.\nQuiet.",
      expression: {
        emotion: "joyful",
        parts: [
          { text: "Hello." },
          { text: "\n" },
          { text: "Still happy." },
          { text: "\n" },
          { text: "Quiet.", emotion: "tender" },
        ],
      },
    });
  });

  it("applies a subsequent root emotion before leading events on the real separator", () => {
    expect(
      collectNativeSpeechPresentation(
        message([
          block("Before.", { emotion: "joyful", parts: [{ text: "Before." }] }),
          block("After.", {
            emotion: "tender",
            parts: [
              { event: "sigh" },
              { text: "After.", emotion: "surprised" },
              { event: "laugh" },
            ],
          }),
        ]),
      ),
    ).toEqual({
      tagged: true,
      text: "Before.\nAfter.",
      expression: {
        emotion: "joyful",
        parts: [
          { text: "Before." },
          { text: "\n", emotion: "tender" },
          { event: "sigh" },
          { text: "After.", emotion: "surprised" },
          { event: "laugh" },
        ],
      },
    });
  });

  it("rejects metadata whose text no longer matches its block", () => {
    const value = block("Hello.");
    value.text = "Changed.";
    expect(() => collectNativeSpeechPresentation(message([value]))).toThrow("exact text block");
  });

  it("bounds merged expressions instead of individually admitting unlimited blocks", () => {
    const values = Array.from({ length: 65 }, () =>
      block("Hi.", { emotion: "joyful", parts: [{ text: "Hi." }] }),
    );
    expect(() => collectNativeSpeechPresentation(message(values))).toThrow();
    expect(() =>
      collectNativeSpeechPresentation(
        message([block("x".repeat(10_000)), block("x".repeat(10_000))]),
      ),
    ).toThrow("budget");
  });
});

describe("slice native speech presentation facts", () => {
  const facts: AssistantDeliveryTtsFacts = {
    tagged: true,
    text: "Hi. Hi. Bye.",
    expression: {
      emotion: "joyful",
      parts: [
        { text: "Hi. " },
        { event: "laugh" },
        { text: "Hi. ", emotion: "tender" },
        { text: "Bye." },
        { event: "sigh" },
      ],
    },
  };

  it("leaves ordinary replies without metadata unchanged", () => {
    expect(sliceNativeSpeechPresentation(undefined, "Hello.")).toBeUndefined();
  });

  it("retains all metadata for the whole exact projection", () => {
    expect(sliceNativeSpeechPresentation(facts, facts.text!)).toEqual(facts);
  });

  it("uses authoritative ranges to select repeated text and preserve event ownership", () => {
    expect(sliceNativeSpeechPresentation(facts, "Hi. ", [0, 4])).toEqual({
      tagged: true,
      text: "Hi. ",
      expression: { emotion: "joyful", parts: [{ text: "Hi. " }] },
    });
    expect(sliceNativeSpeechPresentation(facts, "Hi. ", [4, 8])).toEqual({
      tagged: true,
      text: "Hi. ",
      expression: {
        emotion: "joyful",
        parts: [{ event: "laugh" }, { text: "Hi. ", emotion: "tender" }],
      },
    });
  });

  it("allows an unambiguous substring and retains trailing events on the final slice", () => {
    expect(sliceNativeSpeechPresentation(facts, "Bye.")).toEqual({
      tagged: true,
      text: "Bye.",
      expression: { emotion: "tender", parts: [{ text: "Bye." }, { event: "sigh" }] },
    });
  });

  it("allows the whole source to be trimmed without fuzzy matching", () => {
    expect(
      sliceNativeSpeechPresentation(
        { tagged: true, text: "  Hello. \n", expression: { parts: [{ text: "  Hello. \n" }] } },
        "Hello.",
      ),
    ).toEqual({
      tagged: true,
      text: "Hello.",
      expression: { parts: [{ text: "Hello." }] },
    });
  });

  it("retains vocal events at whitespace edges only for proven whole-source trim", () => {
    const value: AssistantDeliveryTtsFacts = {
      tagged: true,
      text: "  Hello.  ",
      expression: {
        emotion: "joyful",
        parts: [
          { event: "gasp" },
          { text: "  Hello." },
          { event: "laugh" },
          { text: "  " },
          { event: "sigh" },
        ],
      },
    };
    expect(sliceNativeSpeechPresentation(value, "Hello.")).toEqual({
      tagged: true,
      text: "Hello.",
      expression: {
        emotion: "joyful",
        parts: [{ event: "gasp" }, { text: "Hello." }, { event: "laugh" }, { event: "sigh" }],
      },
    });
    expect(sliceNativeSpeechPresentation(value, "Hello.", [2, 8])).toEqual({
      tagged: true,
      text: "Hello.",
      expression: { emotion: "joyful", parts: [{ text: "Hello." }] },
    });
  });

  it("assigns skipped whitespace-gap events once to the following authoritative chunk", () => {
    const value: AssistantDeliveryTtsFacts = {
      tagged: true,
      text: "Hi. Next. ",
      expression: {
        emotion: "joyful",
        parts: [
          { text: "Hi." },
          { event: "laugh" },
          { text: " Next." },
          { event: "gasp" },
          { text: " " },
          { event: "sigh" },
        ],
      },
    };
    const options = { retainWhitespaceEdgeEvents: true };
    const first = sliceNativeSpeechPresentation(value, "Hi.", [0, 3], options);
    const second = sliceNativeSpeechPresentation(value, "Next.", [4, 9], options);
    expect(first?.expression?.parts).toEqual([{ text: "Hi." }]);
    expect(second?.expression?.parts).toEqual([
      { event: "laugh" },
      { text: "Next." },
      { event: "gasp" },
      { event: "sigh" },
    ]);
  });

  it("keeps exact repeated-text offsets without absorbing earlier or later nonwhitespace events", () => {
    const options = { retainWhitespaceEdgeEvents: true };
    expect(sliceNativeSpeechPresentation(facts, "Hi.", [4, 7], options)?.expression?.parts).toEqual(
      [{ event: "laugh" }, { text: "Hi.", emotion: "tender" }],
    );
    expect(
      sliceNativeSpeechPresentation(facts, "Bye.", [8, 12], options)?.expression?.parts,
    ).toEqual([{ text: "Bye." }, { event: "sigh" }]);
  });

  it("restores audible-text emotion after a removed whitespace-only emotion change", () => {
    const value: AssistantDeliveryTtsFacts = {
      tagged: true,
      text: "A.  B.",
      expression: {
        emotion: "joyful",
        parts: [
          { text: "A." },
          { event: "laugh" },
          { text: " ", emotion: "tender" },
          { event: "sigh" },
          { text: " B." },
        ],
      },
    };
    expect(
      sliceNativeSpeechPresentation(value, "B.", [4, 6], { retainWhitespaceEdgeEvents: true }),
    ).toEqual({
      tagged: true,
      text: "B.",
      expression: {
        emotion: "joyful",
        parts: [{ event: "laugh" }, { event: "sigh" }, { text: "B.", emotion: "tender" }],
      },
    });
  });

  it.each(["Hi.", "Absent.", "hi.", ""])(
    "rejects ambiguous or mismatched projection %j",
    (text) => {
      expect(() => sliceNativeSpeechPresentation(facts, text)).toThrow();
    },
  );

  it.each([
    [-1, 3],
    [0, 0],
    [4, 7],
    [0, 50],
    [0.1, 3],
  ] as const)("rejects a wrong authoritative range (%s, %s)", (start, end) => {
    expect(() => sliceNativeSpeechPresentation(facts, "Hi. ", [start, end])).toThrow(
      "source range",
    );
  });
});
