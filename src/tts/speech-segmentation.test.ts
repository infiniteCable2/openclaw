import { describe, expect, it } from "vitest";
import { EmbeddedBlockChunker } from "../agents/embedded-agent-block-chunker.js";
import type { SpeechSegmentationProfile } from "./provider-types.js";
import { prepareSpeechSegments } from "./speech-segmentation.js";

const profile: SpeechSegmentationProfile = {
  minChars: 0,
  targetWords: 32,
  maxWords: 45,
  maxChars: 400,
  pauses: { paragraph: 320, sentence: 180, clause: 80, fragment: 60 },
};

describe("native model-specific speech segmentation", () => {
  it("does not turn emotion changes into extra generation boundaries", () => {
    const text = "Ich bin hier. Es ist still. Jetzt geht es weiter.";
    const kitten = { ...profile, minChars: 130 };
    expect(
      prepareSpeechSegments(text, kitten, {
        emotion: "joyful",
        parts: [
          { text: "Ich bin hier. " },
          { text: "Es ist still. ", emotion: "sad" },
          { text: "Jetzt geht es weiter.", emotion: "joyful" },
        ],
      }),
    ).toEqual(prepareSpeechSegments(text, kitten));
  });

  it("preserves established paragraph units and pauses for a zero-minimum backend", () => {
    expect(prepareSpeechSegments("Hallo Welt.\n\nEin zweiter Absatz.", profile)).toEqual([
      { text: "Hallo Welt.", pauseMs: 320 },
      { text: "Ein zweiter Absatz.", pauseMs: 180 },
    ]);
  });

  it("merges short paragraphs for a backend minimum but flushes a short completed greeting", () => {
    const kitten = { ...profile, minChars: 130 };
    const text = "Ein kurzer Absatz.\n\nNoch ein kurzer Absatz.\n\nUnd ein dritter kurzer Absatz.";
    expect(prepareSpeechSegments(text, kitten)).toEqual([{ text, pauseMs: 180 }]);
    expect(prepareSpeechSegments("Guten Morgen!", kitten)).toEqual([
      { text: "Guten Morgen!", pauseMs: 180 },
    ]);
    const chunker = new EmbeddedBlockChunker({ minChars: 130, maxChars: 400, speech: kitten });
    const chunks: string[] = [];
    chunker.append("Guten Morgen!");
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });
    expect(chunks).toEqual([]);
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });
    expect(chunks).toEqual(["Guten Morgen!"]);
  });

  it("uses word and character hard budgets without dropping source text", () => {
    const text = Array.from({ length: 24 }, (_, index) => `Wort${index}`).join(" ");
    const limits = { ...profile, targetWords: 4, maxWords: 6, maxChars: 64 };
    const segments = prepareSpeechSegments(text, limits);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.map((segment) => segment.text).join(" ")).toBe(text);
    for (const segment of segments) {
      expect(segment.text.split(/\s+/u).length).toBeLessThanOrEqual(6);
      expect(segment.text.length).toBeLessThanOrEqual(64);
    }
  });

  it.each([0, 130])(
    "buffers unfinished streamed sentences with a %i-character minimum",
    (minChars) => {
      const speech = { ...profile, minChars };
      const stream = new EmbeddedBlockChunker({ minChars, maxChars: speech.maxChars, speech });
      const emitted: string[] = [];
      const text =
        "Hallo ich prüfe jetzt die vollständige Verarbeitung deiner längeren Aussage und halte den Satz dabei zusammen bis die Ausgabe wirklich abgeschlossen ist";
      for (const word of text.split(" ")) {
        stream.append(`${word} `);
        stream.drain({ force: false, emit: (chunk) => emitted.push(chunk) });
        expect(emitted).toEqual([]);
      }
      stream.drain({ force: true, emit: (chunk) => emitted.push(chunk) });
      expect(emitted).toEqual([text]);
    },
  );

  it("emits completed ICU segments but retains their unfinished streaming tail", () => {
    const stream = new EmbeddedBlockChunker({ minChars: 0, maxChars: 400, speech: profile });
    const emitted: string[] = [];
    stream.append("Hallo Welt. Danach ");
    stream.drain({ force: false, emit: (chunk) => emitted.push(chunk) });
    expect(emitted).toEqual(["Hallo Welt."]);
    stream.append("geht es weiter.");
    stream.drain({ force: true, emit: (chunk) => emitted.push(chunk) });
    expect(emitted).toEqual(["Hallo Welt.", "Danach geht es weiter."]);
  });

  it("rejects an atomic emphasis span above the model word ceiling even within its character budget", () => {
    const text = "eins zwei drei";
    const limits = { ...profile, targetWords: 2, maxWords: 2, maxChars: 64 };
    expect(() =>
      prepareSpeechSegments(text, limits, {
        parts: [{ text, emphasis: true }],
      }),
    ).toThrow("Speech expression span exceeds");
  });

  it("preserves numeric list labels and exact emphasis spans", () => {
    const text = "1. Bitte merke diese wichtigen vier Wörter. 2. Danach geht es weiter.";
    const emphasis = "diese wichtigen vier Wörter";
    const start = text.indexOf(emphasis);
    const segments = prepareSpeechSegments(
      text,
      { ...profile, targetWords: 8, maxWords: 10 },
      {
        parts: [
          { text: text.slice(0, start) },
          { text: emphasis, emphasis: true },
          { text: text.slice(start + emphasis.length) },
        ],
      },
    );
    expect(segments[0]?.text).not.toBe("1.");
    expect(segments.some((segment) => segment.text.includes(emphasis))).toBe(true);
    expect(segments.map((segment) => segment.text).join(" ")).toBe(text);
  });

  it("rejects malformed profile budgets and preserves astral characters at hard cuts", () => {
    expect(() => prepareSpeechSegments("Hallo", { ...profile, targetWords: 46 })).toThrow(
      "invalid segmentation",
    );
    const text = "😀".repeat(80);
    expect(
      prepareSpeechSegments(text, { ...profile, maxChars: 65 })
        .map((part) => part.text)
        .join(""),
    ).toBe(text);
    expect(() => prepareSpeechSegments("x".repeat(80), { ...profile, maxChars: 64 })).toThrow(
      "One speech word",
    );
  });

  it("keeps times, decimals and Unicode words within the selected word budget", () => {
    const text = "9:30 Uhr, 3,5 Grad – größer_werden";
    const segments = prepareSpeechSegments(text, {
      ...profile,
      targetWords: 3,
      maxWords: 3,
      maxChars: 64,
    });
    expect(segments.map((part) => part.text)).toEqual(["9:30 Uhr,", "3,5 Grad –", "größer_werden"]);
    expect(segments.map((part) => part.text).join(" ")).toBe(text);
  });

  it("does not split German titles, initials, abbreviations, times or numeric lists", () => {
    const text =
      "Dr. Müller kommt um 9:30 Uhr. Danach betrifft es z. B. die Lampe. 1. Schalte sie an. 2. Schalte sie aus.";
    const limits = { ...profile, targetWords: 8, maxWords: 14, maxChars: 100 };
    const completed = prepareSpeechSegments(text, limits);
    expect(completed.map((part) => part.text).join(" ")).toBe(text);
    expect(completed.some((part) => /(?:Dr|z|B)\.$/u.test(part.text))).toBe(false);
    const stream = new EmbeddedBlockChunker({ minChars: 0, maxChars: 100, speech: limits });
    const emitted: string[] = [];
    for (const word of text.split(" ")) {
      stream.append(`${word} `);
      stream.drain({ force: false, emit: (part) => emitted.push(part) });
    }
    stream.drain({ force: true, emit: (part) => emitted.push(part) });
    expect(emitted.map((part) => part.trim()).join(" ")).toBe(text);
    expect(emitted.some((part) => /(?:Dr|z|B)\.$/u.test(part))).toBe(false);
  });

  it("keeps a short paragraph independent even when the next paragraph reaches the word target", () => {
    const first = "Das ist ein kurzer Absatz.";
    const second = "Das ist ein zweiter längerer Absatz mit mehr Wörtern und einem klaren Ende.";
    expect(
      prepareSpeechSegments(`${first}\n\n${second}`, { ...profile, targetWords: 8 })[0],
    ).toEqual({ text: first, pauseMs: 320 });
  });
});
