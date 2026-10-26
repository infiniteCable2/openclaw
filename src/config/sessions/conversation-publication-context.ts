import { AsyncLocalStorage } from "node:async_hooks";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { getUserTurnTranscriptAdmissionOwner } from "../../sessions/user-turn-transcript-admission.js";
import { retainUserTurnTranscriptContinuity } from "../../sessions/user-turn-transcript-continuity.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readConversationObservationRole } from "./conversation-observation.js";
import { wakeConversationPublication } from "./conversation-publication-wakeup.js";
import type { ConversationPublicationIntent } from "./conversation-publication.types.js";
import type {
  LockedTranscriptMessageAppendOptions,
  SessionTranscriptWriteLockAccessorContext,
  SessionTranscriptWriteScope,
  TranscriptMessageAppendResult,
} from "./session-accessor.types.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

type PublicationScope = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

type PublicationOwner = {
  source: PublicationScope & { agentId: string; sessionKey: string; sessionId: string };
  storePath?: string;
  recorder?: UserTurnTranscriptRecorder;
  runId: string;
  inputOnly?: true;
  capture(
    role?: "user" | "assistant",
  ): { intent: ConversationPublicationIntent; assertCurrent: SessionSourceAssertion } | undefined;
};

const publicationContext = resolveGlobalSingleton(
  Symbol.for("openclaw.conversationPublicationContext"),
  () => new AsyncLocalStorage<PublicationOwner>(),
);
const capturedAppendOptions = new WeakSet<object>();
const inputOwners = new WeakMap<UserTurnTranscriptRecorder, PublicationOwner>();

/** Native recorder identity carries ingress proof through queues, never through message metadata. */
export function bindConversationPublicationInput(
  recorder: UserTurnTranscriptRecorder,
  owner: Omit<PublicationOwner, "recorder" | "runId" | "inputOnly">,
): void {
  if (getUserTurnTranscriptAdmissionOwner(recorder)) {
    inputOwners.set(recorder, { ...owner, recorder, runId: "", inputOnly: true });
  }
}

/** Select this input's custody even while an earlier input owns the active model run. */
export function withConversationPublicationInput<T>(
  recorder: UserTurnTranscriptRecorder | undefined,
  run: () => T,
): T {
  const owner = recorder && inputOwners.get(recorder);
  return owner ? publicationContext.run(owner, run) : run();
}

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
    appendMessage: async (options) => {
      const captured = captureConversationPublicationAppend(scope, options);
      const result = await context.appendMessage(captured);
      publishConversationPublicationCommit(scope, captured.conversationPublication, result);
      return result;
    },
    appendMessageWithMessageSequence: async (options) => {
      const captured = captureConversationPublicationAppend(scope, options);
      const result = await context.appendMessageWithMessageSequence(captured);
      publishConversationPublicationCommit(scope, captured.conversationPublication, result.result);
      return result;
    },
  };
}

/** Internal host custody; provider payloads and transcript metadata cannot mint this owner. */
export function withConversationPublicationContext<T>(owner: PublicationOwner, run: () => T): T {
  const release = retainUserTurnTranscriptContinuity({
    recorder: owner.recorder,
    source: { ...owner.source, storePath: owner.storePath },
    assertCurrent() {
      const publication = owner.capture();
      if (!publication) {
        throw new Error("Conversation publication no longer owns its original admission");
      }
      publication.assertCurrent();
    },
  });
  try {
    const result = publicationContext.run(owner, run);
    if (result instanceof Promise) {
      // SAFETY: finally preserves the native caller's Promise value/rejection and sync/async shape.
      return result.finally(release) as T;
    }
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

/** Capture before handing an append to a worker; the returned assertion stays on the host. */
export function captureConversationPublication(
  scope: PublicationScope,
  message: unknown,
): ReturnType<PublicationOwner["capture"]> {
  const owner = publicationContext.getStore();
  const role = readConversationObservationRole(message);
  if (
    !owner ||
    scope.agentId !== owner.source.agentId ||
    scope.sessionKey !== owner.source.sessionKey ||
    scope.sessionId !== owner.source.sessionId ||
    !role
  ) {
    return undefined;
  }
  if (
    role === "assistant" &&
    (owner.inputOnly || readSessionTranscriptRunId(message) !== owner.runId)
  ) {
    return undefined;
  }
  if (role === "user") {
    // An arbitrary SDK/user-role append cannot borrow the current person's admission.
    const original = owner.recorder?.getPendingInputMessage?.() ?? owner.recorder?.message;
    const key = readMessageIdempotencyKey(original);
    if (!key || readMessageIdempotencyKey(message) !== key || owner.recorder?.isBlocked()) {
      return undefined;
    }
  }
  const captured = owner.capture(role);
  captured?.assertCurrent();
  return captured && { ...captured, intent: structuredClone(captured.intent) };
}

/** A committed journal row owns recovery; a lost wakeup must not fail or repeat source work. */
export function publishConversationPublicationCommit(
  scope: Pick<SessionTranscriptWriteScope, "agentId" | "env" | "storePath">,
  intent: ConversationPublicationIntent | undefined,
  result: Pick<TranscriptMessageAppendResult<unknown>, "appended" | "anchor"> | undefined,
): void {
  if (
    intent?.kind === "utterance-observation" &&
    (intent.inputKey !== undefined || intent.runId !== undefined) &&
    result?.appended &&
    result.anchor
  ) {
    wakeConversationPublication({
      agentId: result.anchor.agentId,
      path: result.anchor.storePath,
      env: scope.env,
    });
  }
}
