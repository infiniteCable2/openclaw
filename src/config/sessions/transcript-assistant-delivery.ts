import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantDeliveryTtsFacts, AssistantMessage } from "../../llm/types.js";
import { readAssistantTextBlocksForPhase } from "../../shared/chat-message-content.js";
import { createTextPartCodeRegionResolver } from "../../shared/text/code-regions.js";
import { trimTextPreservingCode } from "../../shared/text/text-projection.js";
import { extractTtsDirectiveParts } from "../../tts/directive-facts.js";
import { collectNativeSpeechPresentation } from "../../tts/speech-presentation-facts.js";
import {
  parseInlineDirectiveParts,
  stripInlineDirectivePartsForDelivery,
} from "../../utils/directive-tags.js";
import { readAssistantDeliveryFacts } from "./transcript-assistant-delivery-read.js";
export { projectAssistantTranscriptText } from "./transcript-assistant-delivery-read.js";

type AssistantDirectiveMessage = {
  content?: unknown;
  openclawDelivery?: unknown;
  role?: unknown;
};

type AssistantDeliveryFacts = NonNullable<AssistantMessage["openclawDelivery"]>;

/** Turn-owned display preparation; source text precedes transcript-only hook rewrites. */
export type PrepareAssistantTranscriptMessage = (
  message: AssistantMessage,
  sourceText: string | undefined,
) => AssistantMessage;

/** Record display ownership without rewriting bytes used by runtime transcript identity. */
export function recordAssistantManagedMediaUrls<T extends AssistantDirectiveMessage>(
  message: T,
  urls: readonly string[] | undefined,
): T {
  const mediaUrls = Array.from(new Set(urls?.map((url) => url.trim()).filter(Boolean) ?? []));
  if (message.role === "assistant" && mediaUrls.length > 0) {
    Object.assign(message, {
      openclawDelivery: {
        ...(isRecord(message.openclawDelivery) ? message.openclawDelivery : {}),
        mediaUrls,
      },
    });
  }
  return message;
}

function mergeTtsFacts(
  current: AssistantDeliveryTtsFacts | undefined,
  next: AssistantDeliveryTtsFacts,
): AssistantDeliveryTtsFacts {
  return {
    tagged: true,
    ...((current?.text ?? next.text) != null ? { text: current?.text ?? next.text } : {}),
    ...((current?.expression ?? next.expression) != null
      ? { expression: current?.expression ?? next.expression }
      : {}),
    ...(current?.directives || next.directives
      ? { directives: [...(current?.directives ?? []), ...(next.directives ?? [])] }
      : {}),
  };
}

/** Publish native speech facts and normalize legacy directives once at the transcript boundary. */
// TRANSITIONAL(marker-retirement): once the visibleReplies default flips and the
// model stops emitting inline markers, the legacy parsing below can retire.
// Native per-block speech publication remains the shared delivery-fact owner.
export function applyAssistantDeliveryDirectives<T extends AssistantDirectiveMessage>(
  message: T,
  options?: { managedMediaUrls?: readonly string[] },
): T {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  const finalBlocks = readAssistantTextBlocksForPhase(message, "final_answer");
  const blocks = finalBlocks.length ? finalBlocks : readAssistantTextBlocksForPhase(message);
  // Validate authored facts before legacy normalization can alter their exact text projection.
  collectNativeSpeechPresentation(message);
  const original = blocks.map((block) => block.text);
  const parsed = parseInlineDirectiveParts(original);
  const stripped = stripInlineDirectivePartsForDelivery(parsed.map((part) => part.text));
  const tts = extractTtsDirectiveParts(stripped.map((part) => part.text));
  const codeRegions =
    blocks.length > 1
      ? createTextPartCodeRegionResolver(tts.map((part) => part.cleanedText))
      : undefined;
  const normalizedTexts = tts.map((speech, index) =>
    speech.facts
      ? trimTextPreservingCode(speech.cleanedText, "both", codeRegions?.(index))
      : speech.cleanedText,
  );
  for (const [index, block] of blocks.entries()) {
    if (
      isRecord(block.openclawDelivery) &&
      block.openclawDelivery.tts !== undefined &&
      normalizedTexts[index] !== block.text
    ) {
      throw new Error("Native speech text must not also contain legacy delivery directives");
    }
  }
  let facts: AssistantDeliveryFacts | undefined;
  for (const [index, block] of blocks.entries()) {
    const reply = expectDefined(parsed[index], "parsed assistant part");
    const speech = expectDefined(tts[index], "prepared assistant speech part");
    const hasDeliveryFacts = reply.hasAudioTag || reply.hasReplyTag || Boolean(speech.facts);
    if (speech.cleanedText === original[index] && !hasDeliveryFacts) {
      continue;
    }
    block.text = expectDefined(normalizedTexts[index], "normalized assistant text part");
    if (!hasDeliveryFacts) {
      continue;
    }
    facts ??= {};
    Object.assign(facts, {
      ...(reply.audioAsVoice ? { audioAsVoice: true as const } : {}),
      ...(reply.replyToCurrent ? { replyToCurrent: true as const } : {}),
      ...(reply.replyToExplicitId ? { replyToId: reply.replyToExplicitId } : {}),
      ...(speech.facts ? { tts: mergeTtsFacts(facts.tts, speech.facts) } : {}),
    });
  }
  const nativeSpeech = collectNativeSpeechPresentation(message);
  if (nativeSpeech) {
    facts ??= {};
    facts.tts ??= nativeSpeech;
  }
  if (facts) {
    const currentFacts = isRecord(message.openclawDelivery) ? message.openclawDelivery : undefined;
    const mergedFacts = { ...currentFacts, ...facts };
    const currentTts = readAssistantDeliveryFacts(currentFacts)?.tts;
    if (currentTts && facts.tts) {
      mergedFacts.tts = mergeTtsFacts(currentTts, facts.tts);
    }
    if (nativeSpeech) {
      // Per-block facts are authoritative for this phase; stale message-level speech cannot win.
      const tts: AssistantDeliveryTtsFacts = { ...mergedFacts.tts, ...nativeSpeech };
      if (!nativeSpeech.expression) {
        delete tts.expression;
      }
      mergedFacts.tts = tts;
    }
    if (facts.replyToId) {
      delete mergedFacts.replyToCurrent;
    } else if (facts.replyToCurrent) {
      delete mergedFacts.replyToId;
    }
    Object.assign(message, { openclawDelivery: mergedFacts });
  }
  return recordAssistantManagedMediaUrls(message, options?.managedMediaUrls);
}
