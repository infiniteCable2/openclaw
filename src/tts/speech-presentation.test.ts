import { describe, expect, it } from "vitest";
import type { SpeechExpression } from "../llm/types.js";
import { parseSpeechPresentation, sliceSpeechExpression } from "./speech-presentation.js";

const presentation = {
  type: "speech",
  text: "Hello there.",
  expression: {
    emotion: "joyful",
    parts: [{ text: "Hello " }, { event: "laugh" }, { text: "there.", emphasis: true }],
  },
};

describe("native speech presentation admission", () => {
  it("ignores even stale expression declarations when disabled while retaining clean text", () => {
    for (const expression of [
      presentation.expression,
      null,
      { unknown: true },
      { parts: [{ text: "Wrong." }] },
    ]) {
      expect(
        parseSpeechPresentation(JSON.stringify({ ...presentation, expression }), {
          expressionEnabled: false,
        }),
      ).toEqual({ text: presentation.text });
    }
  });
  it("projects only plain text and keeps expression data in typed delivery facts", () => {
    expect(parseSpeechPresentation(JSON.stringify(presentation))).toEqual({
      text: presentation.text,
      speech: { tagged: true, text: presentation.text, expression: presentation.expression },
    });
  });

  it("allows JSON whitespace and preserves authored plain-text whitespace exactly", () => {
    expect(parseSpeechPresentation(' \n{ \t"type" \r: "speech", "text":" Hello. \\n"}\n')).toEqual({
      text: " Hello. \n",
      speech: { tagged: true, text: " Hello. \n" },
    });
  });

  it("accepts an envelope without optional expression data", () => {
    expect(parseSpeechPresentation('{"type":"speech","text":"Hello."}')).toEqual({
      text: "Hello.",
      speech: { tagged: true, text: "Hello." },
    });
  });

  it.each([
    "Ordinary text.",
    "<laugh> is an example, not a control.",
    'The object is {"type":"speech","text":"Example."}.',
    '`{"type":"speech","text":"Example."}`',
    '```json\n{"type":"speech","text":"Example."}\n```',
    '"{\\"type\\":\\"speech\\",\\"text\\":\\"Example.\\"}"',
    '{"type":"speechless","text":"Example."}',
    '{"text":"Example.","type":"speech"}',
  ])("does not reserve ordinary prose or quoted JSON examples: %s", (text) => {
    expect(parseSpeechPresentation(text)).toEqual({ text });
    expect(parseSpeechPresentation(text, { final: false })).toEqual({ text });
  });

  it("withholds every ambiguous prefix without leaking the envelope during streaming", () => {
    const encoded = JSON.stringify(presentation);
    for (let length = 0; length < encoded.length; length += 1) {
      expect(parseSpeechPresentation(encoded.slice(0, length), { final: false })).toEqual({
        text: "",
        pending: true,
      });
    }
    expect(parseSpeechPresentation(encoded, { final: false }).text).toBe(presentation.text);
  });

  it("releases an ambiguous prefix as ordinary text once it diverges", () => {
    expect(parseSpeechPresentation('{ "typ', { final: false })).toEqual({
      text: "",
      pending: true,
    });
    expect(parseSpeechPresentation('{ "typical": 1', { final: false })).toEqual({
      text: '{ "typical": 1',
    });
    expect(parseSpeechPresentation("{")).toEqual({ text: "{" });
  });

  it.each([
    '{"type":"speech"',
    '{"type":"speech","text":',
    '{"type":"speech",bad}',
    '{"type":"speech","text":"Hello."} trailing',
    '{"type":"speech","text":"Hello."}{"type":"speech","text":"Again."}',
  ])(
    "rejects malformed or unfinished explicit final envelopes without echoing them: %s",
    (text) => {
      expect(() => parseSpeechPresentation(text)).toThrow(
        "Speech presentation requires one complete JSON object",
      );
    },
  );

  it.each([
    { type: "speech" },
    { type: "speech", text: "" },
    { type: "speech", text: 7 },
    { type: "speech", text: "Hello.", unknown: true },
    { type: "speech", text: "Hello.", expression: null },
    { type: "speech", text: "Hello.", expression: { parts: [{ text: "Different." }] } },
    { type: "speech", text: "Hello.", expression: { parts: [{ text: "Hello.", secret: 7 }] } },
  ])("validates the closed envelope and expression projection: %j", (value) => {
    expect(() => parseSpeechPresentation(JSON.stringify(value))).toThrow();
  });

  it("enforces separate text, expression-control, and encoded-byte budgets", () => {
    expect(() =>
      parseSpeechPresentation(JSON.stringify({ type: "speech", text: "x".repeat(16_385) })),
    ).toThrow("bounded text");
    expect(() =>
      parseSpeechPresentation(
        JSON.stringify({
          type: "speech",
          text: "Hi.",
          expression: {
            parts: [{ text: "Hi." }, ...Array.from({ length: 65 }, () => ({ event: "laugh" }))],
          },
        }),
      ),
    ).toThrow("budget");
    const oversized = '{"type":"speech","text":"' + "😀".repeat(16_384) + '"}';
    expect(oversized.length).toBeLessThan(65_536);
    expect(() => parseSpeechPresentation(oversized, { final: false })).toThrow("JSON size budget");
    expect(() => parseSpeechPresentation(oversized)).toThrow("JSON size budget");
  });
});

describe("speech expression slicing", () => {
  const expression: SpeechExpression = {
    emotion: "joyful",
    parts: [
      { event: "gasp" },
      { text: "Hello " },
      { event: "laugh" },
      { text: "quietly. ", emotion: "tender", emphasis: true },
      { text: "Still here." },
      { event: "sigh" },
    ],
  };
  const plain = "Hello quietly. Still here.";

  it("keeps cut-boundary events exactly once and inherits the active emotion", () => {
    expect(sliceSpeechExpression(expression, 0, 6)).toEqual({
      emotion: "joyful",
      parts: [{ event: "gasp" }, { text: "Hello " }],
    });
    expect(sliceSpeechExpression(expression, 6, 15)).toEqual({
      emotion: "joyful",
      parts: [{ event: "laugh" }, { text: "quietly. ", emotion: "tender", emphasis: true }],
    });
    expect(sliceSpeechExpression(expression, 15, plain.length)).toEqual({
      emotion: "tender",
      parts: [{ text: "Still here." }, { event: "sigh" }],
    });
  });

  it("preserves emphasis and prior emotion when a source part is cut internally", () => {
    expect(sliceSpeechExpression(expression, 8, 12)).toEqual({
      emotion: "tender",
      parts: [{ text: "ietl", emphasis: true }],
    });
  });

  it("retains initial events before a first text-part emotion change", () => {
    expect(
      sliceSpeechExpression(
        { parts: [{ event: "gasp" }, { text: "Hello.", emotion: "surprised" }] },
        0,
        6,
      ),
    ).toEqual({
      parts: [{ event: "gasp" }, { text: "Hello.", emotion: "surprised" }],
    });
  });

  it("preserves exact projection and once-only events across every character slice", () => {
    const before = structuredClone(expression);
    const slices = Array.from({ length: plain.length }, (_, index) =>
      sliceSpeechExpression(expression, index, index + 1),
    );
    expect(
      slices.flatMap((slice) => slice.parts).flatMap((part) => ("text" in part ? [part.text] : [])),
    ).toEqual(plain.split(""));
    expect(
      slices
        .flatMap((slice) => slice.parts)
        .flatMap((part) => ("event" in part ? [part.event] : [])),
    ).toEqual(["gasp", "laugh", "sigh"]);
    expect(expression).toEqual(before);
  });

  it.each([
    [-1, 1],
    [0, 0],
    [1, 0],
    [0, 100],
    [0.5, 1],
    [0, Number.NaN],
  ])("rejects invalid source ranges (%s, %s)", (start, end) => {
    expect(() => sliceSpeechExpression(expression, start, end)).toThrow("nonempty source range");
  });

  it("validates the original expression before slicing away unsupported fields", () => {
    expect(() =>
      sliceSpeechExpression({ parts: [{ text: "x".repeat(81), emphasis: true }] }, 0, 1),
    ).toThrow("at most 80");
  });
});
