import { EmbeddedBlockChunker } from "../agents/embedded-agent-block-chunker.js";
import { parseSpeechExpression } from "./expression.js";
import type {
  SpeechExpression,
  SpeechSegmentationProfile,
  SpeechSynthesisSegment,
} from "./provider-types.js";

export function assertSpeechSegmentationProfile(profile: SpeechSegmentationProfile): void {
  const integer = (value: number, min: number, max: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  if (
    !integer(profile.maxChars, 64, 2000) ||
    !integer(profile.minChars, 0, profile.maxChars) ||
    !integer(profile.maxWords, 1, 200) ||
    !integer(profile.targetWords, 1, profile.maxWords) ||
    Object.values(profile.pauses).some((value) => !integer(value, 0, 2000))
  ) {
    throw new Error("Selected speech model returned invalid segmentation budgets");
  }
}

/** The same native chunker owns complete replies and incremental speech blocks. */
export function prepareSpeechSegments(
  text: string,
  profile: SpeechSegmentationProfile,
  expression?: SpeechExpression,
): SpeechSynthesisSegment[] {
  assertSpeechSegmentationProfile(profile);
  const protectedSpans: Array<{ start: number; end: number }> = [];
  if (expression) {
    let offset = 0;
    for (const part of parseSpeechExpression(expression, text).parts) {
      if ("text" in part) {
        if (part.emphasis) {
          protectedSpans.push({ start: offset, end: offset + part.text.length });
        }
        offset += part.text.length;
      }
    }
  }
  const chunker = new EmbeddedBlockChunker({
    minChars: profile.minChars,
    maxChars: profile.maxChars,
    speech: profile,
    speechProtectedSpans: protectedSpans,
  });
  const result: SpeechSynthesisSegment[] = [];
  chunker.append(text);
  chunker.drain({
    force: true,
    emit: (chunk, metadata) => {
      const after = text.slice(metadata!.sourceEnd);
      const pauseMs = /^\s*\n[\t ]*\n/u.test(after)
        ? profile.pauses.paragraph
        : /[.!?]["'»”’)]*$/u.test(chunk)
          ? profile.pauses.sentence
          : /[,;:–—]$/u.test(chunk)
            ? profile.pauses.clause
            : profile.pauses.fragment;
      result.push({ text: chunk, pauseMs });
    },
  });
  if (result.length > 128) {
    throw new Error("Speech request exceeds its prepared segment budget");
  }
  return result;
}
