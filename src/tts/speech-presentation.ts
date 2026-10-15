import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantDeliveryTtsFacts, SpeechExpression } from "../llm/types.js";
import { parseSpeechExpression } from "./expression.js";

const MAX_PRESENTATION_BYTES = 65_536;
const MAX_SPEECH_TEXT = 16_384;
const PRESENTATION_PREFIX = ["{", '"type"', ":", '"speech"'] as const;

export type ParsedSpeechPresentation = {
  text: string;
  speech?: AssistantDeliveryTtsFacts;
  pending?: true;
};

function classifyPresentationPrefix(text: string): "ordinary" | "pending" | "speech" {
  let offset = 0;
  for (const token of PRESENTATION_PREFIX) {
    while (/[ \t\r\n]/u.test(text[offset] ?? "")) {
      offset += 1;
    }
    const available = text.slice(offset, offset + token.length);
    if (!token.startsWith(available)) {
      return "ordinary";
    }
    if (available.length < token.length) {
      return "pending";
    }
    offset += token.length;
  }
  return "speech";
}

/** Admit only the explicit native presentation envelope, never backend markup or quoted examples. */
export function parseSpeechPresentation(
  text: string,
  options: { final?: boolean; expressionEnabled?: boolean } = {},
): ParsedSpeechPresentation {
  const classification = classifyPresentationPrefix(text);
  if (classification === "ordinary" || (classification === "pending" && options.final !== false)) {
    return { text };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PRESENTATION_BYTES) {
    throw new Error("Speech presentation exceeds its JSON size budget");
  }
  if (classification === "pending") {
    return { text: "", pending: true };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    if (options.final === false) {
      return { text: "", pending: true };
    }
    throw new Error("Speech presentation requires one complete JSON object");
  }
  if (
    !isRecord(value) ||
    value.type !== "speech" ||
    Object.keys(value).some((key) => key !== "type" && key !== "text" && key !== "expression") ||
    typeof value.text !== "string" ||
    value.text.length === 0 ||
    value.text.length > MAX_SPEECH_TEXT
  ) {
    throw new Error("Speech presentation requires bounded text and optional expression only");
  }
  // A stale model instruction cannot re-enable controls after the channel disables them.
  if (options.expressionEnabled === false) {
    return { text: value.text };
  }
  const expression =
    value.expression === undefined
      ? undefined
      : parseSpeechExpression(value.expression, value.text);
  return {
    text: value.text,
    speech: {
      tagged: true,
      text: value.text,
      ...(expression ? { expression } : {}),
    },
  };
}

/** Slice by the native chunker's source offsets; boundary events belong to the following slice. */
export function sliceSpeechExpression(
  expression: SpeechExpression,
  start: number,
  end: number,
  options?: { retainWhitespaceEdgeEvents?: boolean },
): SpeechExpression {
  const projection = expression.parts.map((part) => ("text" in part ? part.text : "")).join("");
  const admitted = parseSpeechExpression(expression, projection);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= end ||
    end > projection.length
  ) {
    throw new Error("Speech expression slice requires a nonempty source range");
  }
  let eventStart = start;
  let eventEnd = end;
  if (options?.retainWhitespaceEdgeEvents) {
    while (eventStart > 0 && /\s/u.test(projection[eventStart - 1]!)) {
      eventStart -= 1;
    }
    if (end === projection.trimEnd().length) {
      eventEnd = projection.length;
    }
  }
  const parts: SpeechExpression["parts"] = [];
  let offset = 0;
  let activeEmotion = admitted.emotion;
  let initialEmotion: string | undefined;
  let renderedEmotion: string | undefined;
  let initialized = false;
  for (const part of admitted.parts) {
    if ("event" in part) {
      if (
        offset >= eventStart &&
        (offset < eventEnd || (offset === eventEnd && eventEnd === projection.length))
      ) {
        if (!initialized) {
          initialEmotion = activeEmotion;
          renderedEmotion = initialEmotion;
          initialized = true;
        }
        parts.push({ event: part.event });
      }
      continue;
    }
    activeEmotion = part.emotion ?? activeEmotion;
    const sourceEnd = offset + part.text.length;
    const overlapStart = Math.max(start, offset);
    const overlapEnd = Math.min(end, sourceEnd);
    if (overlapStart < overlapEnd) {
      const firstPart = !initialized;
      if (firstPart) {
        initialEmotion = activeEmotion;
        renderedEmotion = initialEmotion;
        initialized = true;
      }
      parts.push({
        text: part.text.slice(overlapStart - offset, overlapEnd - offset),
        ...(!firstPart && (part.emotion || activeEmotion !== renderedEmotion)
          ? { emotion: activeEmotion }
          : {}),
        ...(part.emphasis === undefined ? {} : { emphasis: part.emphasis }),
      });
      renderedEmotion = activeEmotion;
    }
    offset = sourceEnd;
  }
  return parseSpeechExpression(
    { ...(initialEmotion ? { emotion: initialEmotion } : {}), parts },
    projection.slice(start, end),
  );
}
