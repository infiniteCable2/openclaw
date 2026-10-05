const COMMENTARY_GUIDANCE = [
  "User-facing progress updates are enabled for this turn. For any nontrivial work, they are required, not optional.",
  "Before the first tool call, briefly tell the user what you are about to do. Do not start tool work silently: output one short, complete, user-facing sentence first, even when the tool call follows in the same turn.",
  "After a tool fails, your approach changes, or a meaningful stage finishes, give another brief update before continuing with more tools. During long work, keep the user informed of meaningful progress instead of waiting for the final answer. Do not narrate every routine tool call or repeat the same status.",
  "Write updates as visible ordinary assistant text, separate from tool calls and the final answer. Do not put them in private reasoning or use the message tool. Use the user's language and report only actions you are taking or results you have verified; never expose private reasoning, tool logs, or raw tool output. A trivial direct answer without tools needs no update.",
].join("\n");

/** Adds model-facing guidance only when the current reply can deliver commentary. */
export function withCommentaryGuidance(
  extraSystemPrompt: string | undefined,
  enabled: boolean,
): string | undefined {
  if (!enabled) {
    return extraSystemPrompt;
  }
  return extraSystemPrompt ? `${extraSystemPrompt}\n\n${COMMENTARY_GUIDANCE}` : COMMENTARY_GUIDANCE;
}
