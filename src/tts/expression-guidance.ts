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
    "Speech controls are optional. If no special emotion, emphasis, or vocal event is intended, omit voiceExpression; ordinary text is valid spoken content and needs no expression block.",
    params.currentSourceSpeechTarget
      ? "Use the existing message tool with action=send for each spoken utterance, including plain utterances without expression controls."
      : "Ordinary assistant replies use the configured automatic speech delivery. Use the existing message tool with action=send for expressive utterances or separate progress updates.",
    "For message sends to this source, omit channel, to, target, targets, and threadId unless the user explicitly requests a different destination.",
    `The output target is ${params.target}. Use only the following admitted speech controls:`,
    `Emotion identifiers: ${JSON.stringify(emotions)}. Vocal event identifiers: ${JSON.stringify(events)}. Emphasis: ${params.capabilities.emphasis ? "supported" : "unsupported"}.`,
    "Keep message as the clean visible answer. When adding speech controls, put the exact plain spoken words in voiceText and supply voiceExpression separately: {emotion?: identifier, parts: [{text: words, emphasis?: boolean} | {event: identifier}]}. Concatenating all text parts must equal voiceText exactly; event parts contribute no visible text.",
    "When expression is useful, choose an appropriate emotion for that utterance, not a fixed emotion for the entire conversation. Send successive utterances to change emotion between sentences. Place supported vocal events between words and emphasis on a short word or phrase; never split a word or fabricate an unsupported control.",
    "For low latency with message sends, send each complete short utterance when ready, normally one sentence and no more than 320 characters. Keep order. Set final=false until the last answer utterance, then final=true. A plain utterance needs no structured expression plan.",
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
