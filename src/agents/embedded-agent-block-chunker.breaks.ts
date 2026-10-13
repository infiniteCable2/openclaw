import { isSafeFenceBreak, type FenceSpan } from "../../packages/markdown-core/src/fences.js";
import type { BreakSpan } from "./embedded-agent-block-chunker.tables.js";

export function findSafeSentenceBreakIndex(
  text: string,
  unsafeSpans: readonly BreakSpan[],
  minChars: number,
  offset = 0,
  openFence?: FenceSpan,
): number {
  const matches = text.matchAll(/[.!?](?=\s|$)/g);
  let sentenceIdx = -1;
  for (const match of matches) {
    const at = match.index;
    if (at < minChars) {
      continue;
    }
    const candidate = at + 1;
    if (
      offset + candidate !== openFence?.end &&
      isSafeFenceBreak(unsafeSpans, offset + candidate)
    ) {
      sentenceIdx = candidate;
    }
  }
  return sentenceIdx >= minChars ? sentenceIdx : -1;
}

export function findSafeLineBreakIndex(params: {
  text: string;
  unsafeSpans: readonly BreakSpan[];
  minChars: number;
  reverse: boolean;
  separator: "\n" | "\n\n";
  offset?: number;
}): number {
  const { text, unsafeSpans, minChars, reverse, separator, offset = 0 } = params;
  let index = reverse ? text.lastIndexOf(separator) : text.indexOf(separator);
  while (reverse ? index >= minChars : index !== -1) {
    for (let candidate = index; candidate < index + separator.length; candidate++) {
      if (candidate >= minChars && isSafeFenceBreak(unsafeSpans, offset + candidate)) {
        return candidate;
      }
    }
    index = reverse
      ? text.lastIndexOf(separator, index - 1)
      : text.indexOf(separator, index + separator.length);
  }
  return -1;
}
