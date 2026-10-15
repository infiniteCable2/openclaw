import type { AssistantMessage, AssistantMessageEvent, TextContent } from "../../../llm/types.js";
import { parseSpeechPresentation } from "../../../tts/speech-presentation.js";
import type { StreamFn } from "../../runtime/index.js";
import { createStreamIteratorWrapper } from "../../stream-iterator-wrapper.js";
import { mapAssistantMessageStream, wrapStreamObjectEvents } from "./stream-wrapper.js";

function projectText(block: TextContent, final: boolean, expressionEnabled: boolean): TextContent {
  // A projected block can cross several native stream/result consumers. Its
  // already parsed facts must not be interpreted as another provider envelope.
  if (block.openclawDelivery?.tts) {
    if (expressionEnabled) {
      return block;
    }
    const { openclawDelivery: _delivery, ...plain } = block;
    return plain;
  }
  const parsed = parseSpeechPresentation(block.text, { final, expressionEnabled });
  if (parsed.text === block.text && !parsed.speech) {
    return block;
  }
  return {
    ...block,
    text: parsed.text,
    ...(parsed.speech
      ? { openclawDelivery: { ...block.openclawDelivery, tts: parsed.speech } }
      : {}),
  };
}

function projectMessage(
  message: AssistantMessage,
  final: boolean,
  expressionEnabled: boolean,
  finalIndex?: number,
): AssistantMessage {
  let changed = false;
  const content = message.content.map((block, index) => {
    if (block.type !== "text") {
      return block;
    }
    const projected = projectText(block, final || index === finalIndex, expressionEnabled);
    changed ||= projected !== block;
    return projected;
  });
  return changed ? { ...message, content } : message;
}

/** Install only for an admitted speech run; provider text/reasoning/tool ownership is unchanged. */
export function wrapStreamFnWithSpeechPresentation(
  streamFn: StreamFn,
  assertCurrent: () => void,
  options: { expressionEnabled?: boolean } = {},
): StreamFn {
  const expressionEnabled = options.expressionEnabled !== false;
  return (model, context, options) => {
    assertCurrent();
    return mapAssistantMessageStream(streamFn(model, context, options), (source) => {
      assertCurrent();
      const blocks = new Map<number, { raw: string; emitted: string }>();
      // Keep native producer-settlement identity. Decorate consumer methods,
      // but hand the normalization owner cloned event shells: providers reuse
      // their event/message objects while appending subsequent tokens.
      const originalResult = source.result.bind(source);
      source.result = async () => {
        assertCurrent();
        const message = await originalResult();
        assertCurrent();
        return projectMessage(message, true, expressionEnabled);
      };
      const originalIterator = source[Symbol.asyncIterator].bind(source);
      source[Symbol.asyncIterator] = () => {
        assertCurrent();
        return createStreamIteratorWrapper({
          iterator: originalIterator(),
          next: async (iterator) => {
            assertCurrent();
            const next = await iterator.next();
            assertCurrent();
            return next.done ? next : { ...next, value: { ...next.value } };
          },
        });
      };
      return wrapStreamObjectEvents(source, (record) => {
        assertCurrent();
        // wrapStreamObjectEvents is the protocol owner; its generic callback
        // surface also supports other decorators, but this stream is typed.
        const event = record as AssistantMessageEvent;
        if (event.type === "done") {
          event.message = projectMessage(event.message, true, expressionEnabled);
          return;
        }
        if (event.type === "error") {
          event.error = projectMessage(event.error, true, expressionEnabled);
          return;
        }
        if (
          event.type === "text_start" ||
          event.type === "text_delta" ||
          event.type === "text_end"
        ) {
          const previous = blocks.get(event.contentIndex) ?? { raw: "", emitted: "" };
          const snapshot = event.partial?.content[event.contentIndex];
          const raw =
            event.type === "text_end"
              ? event.content
              : snapshot?.type === "text"
                ? snapshot.text
                : event.type === "text_delta"
                  ? previous.raw + event.delta
                  : previous.raw;
          const projected = projectText(
            snapshot?.type === "text" ? { ...snapshot, text: raw } : { type: "text", text: raw },
            event.type === "text_end",
            expressionEnabled,
          );
          if (!projected.text.startsWith(previous.emitted)) {
            throw new Error("speech presentation changed previously emitted text");
          }
          if (event.type === "text_delta") {
            event.delta = projected.text.slice(previous.emitted.length);
            previous.emitted = projected.text;
          } else if (event.type === "text_end") {
            event.content = projected.text;
          }
          previous.raw = raw;
          blocks.set(event.contentIndex, previous);
        }
        if (event.partial) {
          event.partial = projectMessage(
            event.partial,
            false,
            expressionEnabled,
            event.type === "text_end" ? event.contentIndex : undefined,
          );
        }
      });
    });
  };
}
