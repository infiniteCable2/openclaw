import type { AssistantMessage } from "../llm/types.js";
import { readAssistantTextBlocksForPhase } from "../shared/chat-message-content.js";
import {
  collectNativeSpeechPresentation,
  sliceNativeSpeechPresentation,
} from "../tts/speech-presentation-facts.js";

/** Bind buffered prose to its producer frame, not a later compact item snapshot. */
export function captureNativeBlockSpeechSource(message: AssistantMessage) {
  if (!message.content.some((block) => block.type === "text" && block.openclawDelivery?.tts)) {
    return undefined;
  }
  // Parsed delivery facts are detached from the provider. Snapshot only the text
  // coordinates; raw provider text blocks may still be reused on later updates.
  return {
    ...message,
    content: message.content.map((block) => (block.type === "text" ? { ...block } : block)),
  };
}

/** Translate the native chunker's scoped UTF-16 coordinates, never search repeated chunks. */
export function projectNativeBlockSpeech(params: {
  message: AssistantMessage;
  text: string;
  commentary?: boolean;
  sourceContentIndex?: number;
  sourceRange?: readonly [number, number];
  sourceOffset?: number;
}) {
  const phase = params.commentary ? "commentary" : "final_answer";
  const facts = collectNativeSpeechPresentation(params.message, phase);
  if (!facts) {
    return undefined;
  }
  if (!params.sourceRange) {
    return {
      tts: sliceNativeSpeechPresentation(facts, params.text),
      ...(facts.text === params.text ? { sourceRange: [0, params.text.length] as const } : {}),
    };
  }
  const explicit = readAssistantTextBlocksForPhase(params.message, phase);
  const blocks = (
    explicit.length || params.commentary
      ? explicit
      : readAssistantTextBlocksForPhase(params.message)
  ).filter((block) => block.text.trim());
  const content = params.message.content;
  let prefix = 0;
  for (const block of blocks) {
    if (content.findIndex((entry) => entry === block) >= (params.sourceContentIndex ?? 0)) {
      break;
    }
    prefix += block.text.length + 1;
  }
  const start = prefix + params.sourceRange[0] - (params.sourceOffset ?? 0);
  const end = prefix + params.sourceRange[1] - (params.sourceOffset ?? 0);
  const source = facts.text ?? "";
  const raw = source.slice(start, end);
  // Native delivery may trim a chunk's trailing separator, but must not move its origin.
  const projectedEnd = raw.trimEnd() === params.text ? start + params.text.length : end;
  return {
    tts: sliceNativeSpeechPresentation(facts, params.text, [start, projectedEnd], {
      retainWhitespaceEdgeEvents: true,
    }),
    sourceRange: [start, projectedEnd] as const,
  };
}
