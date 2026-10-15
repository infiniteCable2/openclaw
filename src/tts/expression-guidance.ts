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
    "Speech controls are optional. If no special emotion, emphasis, or vocal event is intended, omit expression (voiceExpression for explicit sends); ordinary text is valid spoken content and needs no expression block.",
    "Ordinary assistant replies use the configured automatic speech delivery. Plain utterances without expression controls need no special format and no message tool.",
    'For native expressive output, write exactly one JSON object per native text block, with type first: {"type":"speech","text":"the clean spoken words","expression":{"parts":[{"text":"the clean spoken words","emotion":"a supported identifier"}]}}. Do not use a Markdown fence or surrounding prose. The host displays only text and passes expression separately to TTS. Use this same presentation contract for native commentary and the final answer; it does not send to another destination or grant tool permissions.',
    "Use message only when it is actually available and the task needs an explicit message action. For sends to this source, omit channel, to, target, targets, and threadId unless the user explicitly requests a different destination.",
    `The output target is ${params.target}. Use only the following admitted speech controls:`,
    `Emotion identifiers: ${JSON.stringify(emotions)}. Vocal event identifiers: ${JSON.stringify(events)}. Emphasis: ${params.capabilities.emphasis ? "supported" : "unsupported"}.`,
    "Native expression uses {emotion?: identifier, parts: [{text: words, emotion?: identifier, emphasis?: boolean} | {event: identifier}]}. Concatenating all text parts must equal the envelope text exactly; event parts contribute no visible text. For an explicit message action, keep message clean, put the plain spoken words in voiceText and the same expression in voiceExpression.",
    "The top-level emotion initializes this utterance. A text part's emotion changes the active emotion from that part onward until the next explicit change; omitted emotion keeps the active value. Group consecutive sentences with the same emotion in one text part. Change emotion at sentence boundaries, not inside words or emphasis. The speech adapter repeats the active emotion for each sentence; do not repeat tags or send separate messages just to change emotion. Place supported vocal events between words and emphasis on a short word or phrase; never fabricate an unsupported control.",
    "For low latency with message sends, send each complete short utterance when ready, normally one sentence and no more than 320 characters. Keep order. Set final=false until the last answer utterance, then final=true. A plain utterance needs no structured expression plan.",
    params.commentaryEnabled
      ? "Keep native commentary separate from the final answer. Do not repeat already delivered progress. Native presentation does not change the phase or end the run; tool calls and reasoning remain separate. If an explicit current-source message action is available, commentary uses replyPhase=commentary and final=false."
      : "Commentary is disabled for this output; do not send commentary utterances.",
    "Do not write Kitten tags or OpenClaw TTS directives in the spoken text, message, or voiceText. Only the speech adapter renders backend markup from admitted expression facts. Do not produce an extra ordinary-text copy of a native presentation object.",
    "An expressive output is not a request to whisper. Use only the declared emotion and event identifiers; a provider capability flag alone does not define another identifier.",
  ].join("\n");
}
