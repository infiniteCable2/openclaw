import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { captureConsistentConversationParticipant } from "./session-participant-input.js";

const audienceInput = Symbol.for("openclaw.conversationPrivateAudience");

/** Process-local, host-bound recipient evidence. Never a historical read permission. */
export type ConversationPrivateAudience = Readonly<{
  agentId: string;
  sessionKey: string;
  channelId: string;
  accountId: string;
  nativeChannelId: string;
  participant: SessionParticipantIdentity;
  assertCurrent(): void;
}>;

/** Only consumed channel ingress calls this; ordinary context fields cannot create evidence. */
export function bindConversationPrivateAudience(
  context: object,
  audience: ConversationPrivateAudience,
): void {
  Object.assign(context, { [audienceInput]: audience });
}

export function readConversationPrivateAudience(context: object) {
  // SAFETY: The symbol is installed by the host ingress binder, not by model-visible metadata.
  return Reflect.get(context, audienceInput) as ConversationPrivateAudience | undefined;
}

/** New branch creation only; live evidence never relabels an existing history. */
export function capturePrivateConversationCreationAudience(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  entry?: Pick<InternalSessionEntry, "sessionId">;
  audience?: ConversationPrivateAudience;
}): ConversationPrivateAudience | undefined {
  const { audience } = params;
  if (
    params.entry !== undefined ||
    isIncognitoSessionKey(params.sessionKey) ||
    resolveAgentConversationMode(params.cfg, params.agentId) !== "branches" ||
    audience?.agentId !== params.agentId ||
    audience.sessionKey !== params.sessionKey
  ) {
    return undefined;
  }
  audience.assertCurrent();
  return audience;
}

/** Collection retains every original lifetime and never upgrades a mixed/unconfirmed batch. */
export function collectConversationPrivateAudiences(
  values: readonly (ConversationPrivateAudience | undefined)[],
): ConversationPrivateAudience | undefined {
  const first = values[0];
  if (!first || values.some((value) => !value)) {
    return undefined;
  }
  const held = [...values];
  const participant = captureConsistentConversationParticipant(
    values.map((value) => value?.participant),
  );
  if (
    !participant ||
    values.some(
      (value) =>
        value?.agentId !== first.agentId ||
        value.sessionKey !== first.sessionKey ||
        value.channelId !== first.channelId ||
        value.accountId !== first.accountId ||
        value.nativeChannelId !== first.nativeChannelId,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    ...first,
    participant,
    assertCurrent: () => {
      for (const value of held) {
        value!.assertCurrent();
      }
    },
  });
}
