import type { PreparedInitialSessionContext } from "../../config/sessions/session-initial-context.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";

/** Host-only copied context. The assertion retains separately admitted source read authority. */
export type ReplyInitialSessionContext = {
  agentId: string;
  sessionKey: string;
  context: PreparedInitialSessionContext;
  assertCurrent: SessionSourceAssertion;
};

/** Capture data before reply preparation yields; never restore authority from a transcript. */
export function captureReplyInitialSessionContext(
  source: ReplyInitialSessionContext | undefined,
): ReplyInitialSessionContext | undefined {
  if (!source) {
    return undefined;
  }
  const { agentId, sessionKey, assertCurrent } = source;
  assertCurrent();
  return { agentId, sessionKey, assertCurrent, context: structuredClone(source.context) };
}

/** Seed only the originally selected absent conversation, not a command/reset/binding target. */
export function resolveReplyInitialSessionContext(params: {
  initialContext?: ReplyInitialSessionContext;
  agentId: string;
  sessionKey: string;
  entry?: SessionEntry;
  retargetedSession: boolean;
  isSystemEvent: boolean;
  resetTriggered: boolean;
  parentSessionKey?: string;
  modelParentSessionKey?: string;
}): PreparedInitialSessionContext | undefined {
  const source = params.initialContext;
  if (!source) {
    return undefined;
  }
  source.assertCurrent();
  if (
    source.agentId !== params.agentId ||
    source.sessionKey !== params.sessionKey ||
    params.retargetedSession ||
    params.isSystemEvent ||
    params.resetTriggered ||
    params.entry ||
    params.parentSessionKey ||
    params.modelParentSessionKey
  ) {
    throw new Error(
      "Initial conversation context no longer targets its admitted new conversation.",
    );
  }
  if (!source.context.targetSessionId.trim()) {
    throw new Error("Initial conversation context requires its prospective target identity.");
  }
  return source.context;
}
