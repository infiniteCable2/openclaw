import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";
import {
  readAssistantTextBlocksForPhase,
  type AssistantPhase,
} from "../shared/chat-message-content.js";
import { parseSpeechExpression } from "./expression.js";
import { sliceSpeechExpression } from "./speech-presentation.js";

function readNativeBlockSpeech(block: {
  text: string;
  openclawDelivery?: unknown;
}): AssistantDeliveryTtsFacts | undefined {
  const value = isRecord(block.openclawDelivery) ? block.openclawDelivery.tts : undefined;
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.tagged !== true ||
    value.text !== block.text ||
    Object.keys(value).some((key) => key !== "tagged" && key !== "text" && key !== "expression")
  ) {
    throw new Error("Native speech facts must match their exact text block");
  }
  return {
    tagged: true,
    text: block.text,
    ...(value.expression === undefined
      ? {}
      : { expression: parseSpeechExpression(value.expression, block.text) }),
  };
}

/** Merge one visible native phase without letting commentary become a final answer. */
export function collectNativeSpeechPresentation(
  message: unknown,
  phase: AssistantPhase = "final_answer",
): AssistantDeliveryTtsFacts | undefined {
  const explicit = readAssistantTextBlocksForPhase(message, phase);
  const selected =
    phase === "final_answer" && explicit.length === 0
      ? readAssistantTextBlocksForPhase(message)
      : explicit;
  // Mirror the shared visible-text projection, including its treatment of empty blocks.
  const blocks = selected.filter((block) => block.text.trim());
  const facts = blocks.map(readNativeBlockSpeech);
  if (!facts.some(Boolean)) {
    return undefined;
  }
  const text = blocks.map((block) => block.text).join("\n");
  const parts: NonNullable<AssistantDeliveryTtsFacts["expression"]>["parts"] = [];
  for (const [index, block] of blocks.entries()) {
    const expression = facts[index]?.expression;
    if (index > 0) {
      // The real separator carries a block's root emotion before any leading vocal events.
      parts.push({ text: "\n", ...(expression?.emotion ? { emotion: expression.emotion } : {}) });
    }
    parts.push(...(expression?.parts ?? [{ text: block.text }]));
  }
  const expression = parseSpeechExpression(
    { ...(facts[0]?.expression?.emotion ? { emotion: facts[0].expression.emotion } : {}), parts },
    text,
  );
  return {
    tagged: true,
    text,
    ...(facts.some((fact) => fact?.expression) ? { expression } : {}),
  };
}

/** Preserve exact source ownership when native chunking or display trimming projects a reply. */
export function sliceNativeSpeechPresentation(
  facts: AssistantDeliveryTtsFacts | undefined,
  text: string,
  range?: readonly [number, number],
  options?: { retainWhitespaceEdgeEvents?: boolean },
): AssistantDeliveryTtsFacts | undefined {
  if (!facts) {
    return undefined;
  }
  const source = facts.text;
  if (typeof source !== "string" || !text) {
    throw new Error("Native speech slice requires nonempty source and projected text");
  }
  let start: number;
  let end: number;
  let wholeSourceTrim = false;
  if (range) {
    [start, end] = range;
  } else if (source === text) {
    start = 0;
    end = source.length;
  } else if (source.trim() === text) {
    start = source.length - source.trimStart().length;
    end = start + text.length;
    wholeSourceTrim = true;
  } else {
    start = source.indexOf(text);
    end = start + text.length;
    if (start < 0 || source.indexOf(text, start + 1) >= 0) {
      throw new Error("Native speech slice must have an unambiguous exact source projection");
    }
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= end ||
    end > source.length ||
    source.slice(start, end) !== text
  ) {
    throw new Error("Native speech slice does not match its authoritative source range");
  }
  return {
    ...facts,
    text,
    ...(facts.expression
      ? {
          expression: sliceSpeechExpression(facts.expression, start, end, {
            retainWhitespaceEdgeEvents: wholeSourceTrim || options?.retainWhitespaceEdgeEvents,
          }),
        }
      : {}),
  };
}
