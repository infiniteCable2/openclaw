import { describe, expect, it } from "vitest";
import { markdownToMatrixBody, markdownToMatrixHtml } from "./format.js";

export function registerMatrixFormattedChunkTests(
  chunksFor: (text: string, limit: number) => string[],
) {
  describe("Matrix formatted chunk boundaries", () => {
    it("closes and reopens spoilers without exposing chunked secret text", () => {
      const secret = "secret ".repeat(8).trim();
      const chunks = chunksFor(`before ||${secret}|| after`, 20);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
      for (const chunk of chunks) {
        expect(markdownToMatrixBody(chunk)).not.toContain("secret");
        expect(markdownToMatrixHtml(chunk)).not.toContain("||");
      }
    });

    it("does not pair an unmatched paragraph delimiter with a later spoiler", () => {
      const secret = "secret ".repeat(8).trim();
      const chunks = chunksFor(`first ||\n\nsecond ||${secret}||`, 20);

      expect(chunks.join("")).toContain("[Spoiler]");
      expect(chunks.every((chunk) => !markdownToMatrixBody(chunk).includes("secret"))).toBe(true);
    });

    it("keeps underline-looking tags in code and link metadata literal", () => {
      const markdown = `\`<ins>\` \\<u> [x](https://example.test "literal <u>") ${"plain ".repeat(8)}`;
      const chunks = chunksFor(markdown, 20);

      expect(chunks.join("")).toBe(markdown.trim());
      expect(chunks.join("")).not.toContain("</u>");
    });

    it("keeps spoiler and underline nesting valid across chunks", () => {
      const markdown = `||<u><ins>nested</ins> ${"nested ".repeat(8).trim()}</u>||`;
      const chunks = chunksFor(markdown, 24);

      expect(chunks.every((chunk) => chunk.length <= 24)).toBe(true);
      expect(
        chunks.every((chunk) => {
          const html = markdownToMatrixHtml(chunk);
          return html.includes("<span data-mx-spoiler>") && html.includes("<u>");
        }),
      ).toBe(true);
    });

    it("preserves indentation after a native table segment", () => {
      const table = "| A | B |\n|---|---|\n| 1 | 2 |";
      const code = "    indented code";
      const chunks = chunksFor(`${"prose ".repeat(10)}\n\n${table}\n\n${code}`, 40);

      expect(chunks).toContain(code);
      expect(chunks).toContain(table);
      expect(markdownToMatrixHtml(table, { tableMode: "block" })).toContain("<table>");
    });

    it("recognizes aligned tables and ignores table examples inside fences", () => {
      const aligned = "| A | B |\n| ---: | :---: |\n| 1 | 2 |\n| 3 | 4 |";
      expect(chunksFor(aligned, 35).join("\n")).toContain("• B:");

      const fenced = `\`\`\`\n${aligned}\n\`\`\``;
      expect(chunksFor(fenced, 35).join("")).toBe(fenced);

      const shortDivider = "A|B\n-| -\nbar";
      expect(chunksFor(shortDivider, 8).join("\n")).toContain("**bar**");
    });
  });
}
