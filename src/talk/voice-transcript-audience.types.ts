import type { ConversationPrivateAudience } from "../sessions/conversation-private-audience.js";

/** One native transcript append owns this custody; a retry may borrow but not release it. */
export type PreparedVoiceTranscriptAudience = Readonly<{
  audience: ConversationPrivateAudience;
  release(): void;
}>;

/** Host-only, original ingress callback. No session address or stored actor can create it. */
export type PrepareVoiceTranscriptAudience = (
  this: void,
) => Promise<PreparedVoiceTranscriptAudience | undefined>;
