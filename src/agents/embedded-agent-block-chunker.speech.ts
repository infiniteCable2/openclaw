import { findGraphemeChunkEnd } from "@openclaw/normalization-core/grapheme";
import type { SpeechSegmentationProfile } from "../tts/provider-types.js";

export type SpeechProtectedSpan = { start: number; end: number };

let sentences: Intl.Segmenter | undefined;
let words: Intl.Segmenter | undefined;

/** Same Unicode letter/number/underscore groups as standalone Python's Unicode \w budget. */
export function countSpeechWords(text: string): number {
  return [...text.matchAll(/[\p{L}\p{N}_]+/gu)].length;
}

function isSentenceBoundary(text: string, end: number): boolean {
  const before = text.slice(0, end);
  const after = text.slice(end).trimStart();
  // ICU supplies the language boundaries, but common abbreviations/initials
  // are ambiguous without their following word. Do not speak list ordinals or
  // split a name after its title merely because its dot ends an ICU segment.
  return !(
    /(?:^|\s)\d+[.)]$/u.test(before) ||
    /(?:^|\s)(?:Dr|Prof|Mr|Mrs|Ms|Sr|Jr|St|Nr|No|ca|bzw|inkl|ggf|vgl|usw|etc)\.$/iu.test(before) ||
    (/(?:^|\s)(?:z|d|u|o|s)\.$/iu.test(before) && (!after || /^[\p{L}]\./u.test(after))) ||
    /(?:^|\s)(?:z|d|u|o|s)\.\s+[\p{L}]\.$/iu.test(before) ||
    (/(?:^|\s)[\p{Lu}]\.$/u.test(before) && (!after || /^[\p{L}]/u.test(after)))
  );
}

/** Speech opts into linguistic boundaries; ordinary Markdown/chat chunking is unchanged. */
export function findSpeechChunkEnd(
  text: string,
  profile: SpeechSegmentationProfile,
  force: boolean,
  protectedSpans: readonly SpeechProtectedSpan[] = [],
): number {
  const safe = (at: number) => !protectedSpans.some((span) => at > span.start && at < span.end);
  const candidates = new Set<number>();
  sentences ??= new Intl.Segmenter(undefined, { granularity: "sentence" });
  for (const part of sentences.segment(text)) {
    const end = part.index + part.segment.trimEnd().length;
    // A numbered list label is not a complete spoken sentence.
    if (
      isSentenceBoundary(text, end) &&
      !/^\s*\d+[.)]\s*$/u.test(part.segment) &&
      (force || part.index + part.segment.length < text.length)
    ) {
      candidates.add(end);
    }
  }
  for (const match of text.matchAll(/\n[\t ]*\n+/gu)) {
    candidates.add(match.index);
  }
  const fits = (at: number) =>
    at <= profile.maxChars && countSpeechWords(text.slice(0, at)) <= profile.maxWords;
  const eligible = [...candidates]
    .filter((at) => at > 0 && safe(at) && fits(at) && at >= profile.minChars)
    .sort((a, b) => a - b);
  // Chatterbox's established paragraph units stay independent. Backends with a
  // minimum synthesis size may instead accumulate several short paragraphs.
  const paragraph = eligible.find((at) => /^\n[\t ]*\n/u.test(text.slice(at)));
  if (paragraph !== undefined) {
    return paragraph;
  }
  const target = eligible.find((at) => countSpeechWords(text.slice(0, at)) >= profile.targetWords);
  if (target !== undefined) {
    const beforeTarget = eligible.filter(
      (at) => at <= target && countSpeechWords(text.slice(0, at)) <= profile.targetWords,
    );
    return beforeTarget.at(-1) ?? target;
  }
  const limited = text.length > profile.maxChars || countSpeechWords(text) > profile.maxWords;
  if (!force && !limited) {
    return eligible[0] ?? 0;
  }
  if (force && fits(text.length)) {
    return text.length;
  }
  if (eligible.length > 0) {
    return eligible.at(-1)!;
  }
  // Prefer clauses and then complete words when a long sentence hits a hard
  // budget. Atomic expression spans may not be split to satisfy a soft target.
  const clauses = [...text.matchAll(/[,;:–—](?=\s)/gu)]
    .map((match) => match.index + 1)
    .filter((at) => safe(at) && fits(at));
  if (clauses.length > 0) {
    return clauses.at(-1)!;
  }
  let end = 0;
  words ??= new Intl.Segmenter(undefined, { granularity: "word" });
  for (const part of words.segment(text)) {
    const at = part.index + part.segment.length;
    if (safe(at) && fits(at)) {
      end = at;
    }
    if (at > profile.maxChars || countSpeechWords(text.slice(0, at)) > profile.maxWords) {
      break;
    }
  }
  if (end > 0) {
    return end;
  }
  const firstWord = text.match(/[\p{L}\p{N}_]+/u);
  if (firstWord?.index === 0 && firstWord[0].length > profile.maxChars) {
    throw new Error("One speech word exceeds the selected model's character budget");
  }
  const limit = Math.min(profile.maxChars, text.length);
  const boundary = findGraphemeChunkEnd(text, 0, limit, limit, false);
  if (boundary === 0) {
    throw new Error("One speech grapheme exceeds the selected model's character budget");
  }
  if (!safe(boundary) || !fits(boundary)) {
    throw new Error("Speech expression span exceeds the selected model's synthesis budget");
  }
  return boundary;
}
