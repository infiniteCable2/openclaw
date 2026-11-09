import { resolveUserMessages } from "../../shared/user-messages.js";

/** Native recovery preserves the current session; language only changes presentation. */
export function buildContextOverflowRecoveryText(language?: string): string {
  const messages = resolveUserMessages(language);
  return `${messages.replyContextRecoveryFailed}\n\n${messages.replyLargerContextHint}`;
}
