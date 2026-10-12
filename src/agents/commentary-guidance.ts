const COMMENTARY_WORK_GUIDANCE = [
  "User-facing progress updates are enabled for this turn. For any nontrivial work, they are required, not optional.",
  "Before the first work tool call, briefly tell the user what you are about to do. Do not start tool work silently: deliver one short, complete, user-facing sentence first, even when the work tool call follows in the same turn. Sending the progress update itself is presentation, not a work tool call.",
  "After a tool fails, your approach changes, or a meaningful stage finishes, give another brief update before continuing with more tools. During long work, keep the user informed of meaningful progress instead of waiting for the final answer. Do not narrate every routine tool call or repeat the same status.",
];

const COMMENTARY_GUIDANCE = [
  ...COMMENTARY_WORK_GUIDANCE,
  "Write updates as visible ordinary assistant text, separate from tool calls and the final answer. Do not put them in private reasoning or use the message tool. Use the user's language and report only actions you are taking or results you have verified; never expose private reasoning, tool logs, or raw tool output. A trivial direct answer without tools needs no update.",
].join("\n");

const STRUCTURED_SPEECH_COMMENTARY_GUIDANCE = [
  ...COMMENTARY_WORK_GUIDANCE,
  "Deliver each progress update through the admitted current-source message tool with final=false and the structured speech fields provided for this output. Keep it separate from the final utterance. Do not produce a second ordinary-text copy, private reasoning, tool logs, or raw tool output. Use the user's language and report only actions you are taking or results you have verified. A trivial direct answer without work tools needs no update.",
].join("\n");

/** Adds model-facing guidance only when the current reply can deliver commentary. */
export function withCommentaryGuidance(
  extraSystemPrompt: string | undefined,
  enabled: boolean,
  deliveryMode: "text" | "structured-speech" = "text",
): string | undefined {
  if (!enabled) {
    return extraSystemPrompt;
  }
  const guidance =
    deliveryMode === "structured-speech"
      ? STRUCTURED_SPEECH_COMMENTARY_GUIDANCE
      : COMMENTARY_GUIDANCE;
  return extraSystemPrompt ? `${extraSystemPrompt}\n\n${guidance}` : guidance;
}
