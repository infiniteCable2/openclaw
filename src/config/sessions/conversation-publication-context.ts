import { AsyncLocalStorage } from "node:async_hooks";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { ConversationPublicationIntent } from "./conversation-publication.types.js";
import type {
  LockedTranscriptMessageAppendOptions,
  SessionTranscriptWriteLockAccessorContext,
} from "./session-accessor.types.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "./session-source-authority.js";

type PublicationScope = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

type PublicationOwner = {
  source: PublicationScope & { agentId: string; sessionKey: string; sessionId: string };
  runId: string;
  capture():
    | { intent: ConversationPublicationIntent; assertCurrent: SessionSourceAssertion }
    | undefined;
};

const publicationContext = resolveGlobalSingleton(
  Symbol.for("openclaw.conversationPublicationContext"),
  () => new AsyncLocalStorage<PublicationOwner>(),
);
const capturedAppendOptions = new WeakSet<object>();

/** Keep pre-queue capture intact when the top-level append enters a locked writer. */
export function captureConversationPublicationAppend<T>(
  scope: PublicationScope,
  options: LockedTranscriptMessageAppendOptions<T>,
): LockedTranscriptMessageAppendOptions<T> {
  if (capturedAppendOptions.has(options)) {
    return options;
  }
  const publication = captureConversationPublication(scope, options.message);
  if (!publication) {
    return options;
  }
  const captured = { ...options };
  const source = composeSessionSourceAssertion([
    captureExternalSessionCommitGuard(options.preparation?.source),
    captureExternalSessionCommitGuard(options.beforeFreshMessageCommit),
    publication.assertCurrent,
  ]);
  captured.conversationPublication = publication.intent;
  if (options.beforeFreshMessageCommit || options.prepareMessageAfterIdempotencyCheck) {
    captured.beforeFreshMessageCommit = source;
  } else {
    captured.preparation = { ...options.preparation, source };
  }
  capturedAppendOptions.add(captured);
  return captured;
}

/** Both native and worker locks capture at invocation, before their settlement queues. */
export function withConversationPublicationAppends(
  scope: PublicationScope,
  context: SessionTranscriptWriteLockAccessorContext,
): SessionTranscriptWriteLockAccessorContext {
  return {
    ...context,
    appendMessage: (options) =>
      context.appendMessage(captureConversationPublicationAppend(scope, options)),
    appendMessageWithMessageSequence: (options) =>
      context.appendMessageWithMessageSequence(
        captureConversationPublicationAppend(scope, options),
      ),
  };
}

/** Internal host custody; provider payloads and transcript metadata cannot mint this owner. */
export function withConversationPublicationContext<T>(owner: PublicationOwner, run: () => T): T {
  return publicationContext.run(owner, run);
}

/** Capture before handing an append to a worker; the returned assertion stays on the host. */
export function captureConversationPublication(
  scope: PublicationScope,
  message: unknown,
): ReturnType<PublicationOwner["capture"]> {
  const owner = publicationContext.getStore();
  if (
    !owner ||
    scope.agentId !== owner.source.agentId ||
    scope.sessionKey !== owner.source.sessionKey ||
    scope.sessionId !== owner.source.sessionId ||
    !message ||
    typeof message !== "object" ||
    !("role" in message) ||
    message.role !== "assistant" ||
    !("stopReason" in message) ||
    message.stopReason !== "stop" ||
    ("endTurn" in message && message.endTurn === false) ||
    readSessionTranscriptRunId(message) !== owner.runId
  ) {
    return undefined;
  }
  const captured = owner.capture();
  captured?.assertCurrent();
  return captured && { ...captured, intent: structuredClone(captured.intent) };
}
