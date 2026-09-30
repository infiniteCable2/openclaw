const COMMENTARY_GUIDANCE = [
  "User-facing progress updates are enabled for this turn.",
  "For work involving multiple steps, tools, or a noticeable wait, briefly tell the user what you are about to do before the first tool call. Give another short update only when a meaningful stage changes or a new result affects the work.",
  "Write each update as ordinary assistant text immediately before the relevant tool call, or use a native commentary phase when available. Do not use the message tool for these updates.",
  "Use the user's language. Report only actions you are actually taking or results you have verified; do not reveal private reasoning, tool logs, or raw tool output. Skip updates for trivial work and give a separate final answer when finished.",
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
