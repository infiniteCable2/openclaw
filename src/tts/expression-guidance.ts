import type { SpeechExpressionCapabilities, SpeechSynthesisTarget } from "./provider-types.js";

/** Render already-admitted provider facts; this helper never discovers or prepares a provider. */
export function buildSpeechExpressionGuidance(params: {
  capabilities: SpeechExpressionCapabilities;
  target: SpeechSynthesisTarget;
  currentSourceSpeechTarget: boolean;
  commentaryEnabled: boolean;
}): string {
  const emotions = [...new Set(params.capabilities.emotions)].toSorted();
  const events = [...new Set(params.capabilities.vocalEvents)].toSorted();
  return [
    "Structured speech expression is enabled for this admitted output only.",
    "Use the existing message tool with action=send for spoken replies. Deliver to the implicit current source: omit channel, to, target, targets, and threadId unless the user explicitly requests a different destination.",
    `The output target is ${params.target}. Use only the following admitted speech controls:`,
    `Emotion identifiers: ${JSON.stringify(emotions)}. Vocal event identifiers: ${JSON.stringify(events)}. Emphasis: ${params.capabilities.emphasis ? "supported" : "unsupported"}.`,
    "Keep message as the clean visible answer. Put the exact plain spoken words in voiceText and supply voiceExpression separately: {emotion?: identifier, parts: [{text: words, emphasis?: boolean} | {event: identifier}]}. Concatenating all text parts must equal voiceText exactly; event parts contribute no visible text.",
    "Choose an appropriate emotion for each utterance, not a fixed emotion for the entire conversation. Send successive utterances to change emotion between sentences. Place supported vocal events between words and emphasis on a short word or phrase; never split a word or fabricate an unsupported control.",
    "For low latency, send each complete short utterance when ready, normally one sentence and no more than 320 characters. Keep order. Set final=false until the last answer utterance, then final=true. Include a structured plan even for a neutral utterance; omit emotion when no emotion is needed.",
    ...(params.currentSourceSpeechTarget
      ? [
          'Set replyPhase="final_answer" for every answer utterance. A preceding answer sentence with final=false is still final_answer, not commentary.',
          params.commentaryEnabled
            ? 'For a brief progress update, use replyPhase="commentary" and final=false. It is separate from the final answer; do not repeat it as final-answer text.'
            : "Commentary is disabled for this output; do not send commentary utterances.",
        ]
      : [
          params.commentaryEnabled
            ? "Send brief progress updates separately with final=false, then the answer with the appropriate final flag. Do not repeat already delivered progress in the final answer."
            : "Progress commentary is disabled for this output; send only answer utterances.",
        ]),
    "Do not write Kitten tags, OpenClaw TTS directives, or JSON plans in ordinary assistant text, message, or voiceText. Only the speech adapter renders backend markup from voiceExpression. Do not produce an extra ordinary-text copy after native delivery.",
    "An expressive output is not a request to whisper. Use only the declared emotion and event identifiers; a provider capability flag alone does not define another identifier.",
  ].join("\n");
}
