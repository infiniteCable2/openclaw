import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { readConversationBindingRouteFacts } from "../../channels/conversation-binding-route-facts.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadReplySessionInitializationSnapshot } from "../../config/sessions/session-accessor.reset.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { isPluginOwnedSessionBindingRecord } from "../../plugins/conversation-binding-metadata.js";
import { assertExternalConversationTarget } from "../../routing/conversation-mode.js";
import { isAcpSessionKey, normalizeMainKey } from "../../routing/session-key.js";
import {
  capturePrivateConversationCreationAudience,
  readConversationPrivateAudience,
} from "../../sessions/conversation-private-audience.js";
import { assertPreparedSkillLibrarySelection } from "../../skills/library/selection.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { shouldBypassAcpDispatchForCommand } from "./dispatch-acp-command-bypass.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { getReplyOperationSessionReader } from "./reply-run-registry.state.js";
import {
  resolveSessionConversationBinding,
  type resolveSessionConversationBindingContext,
} from "./session-conversation-binding.js";
import type { SessionEventExecution } from "./session-event-contract.js";
import {
  resolveReplyInitialSessionContext,
  type ReplyInitialSessionContext,
} from "./session-initial-context.js";

export type InitSessionStateParams = {
  assertSourceCurrent?: SessionSourceAssertion;
  assertConversationTarget?: InternalGetReplyOptions["assertConversationTarget"];
  initialSessionContext?: ReplyInitialSessionContext;
  providerReviewAcknowledgment?: import("../../sessions/provider-review.js").ProviderReviewAcknowledgment;
  replyOperation?: ReplyOperation;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
  ctx: FinalizedRuntimeMsgContext;
  expectedExistingSessionId?: string;
  pinExpectedExistingSession?: boolean;
  newlyCreatedSessionId?: string;
  requestedSessionId?: string;
  resumeRequestedSession?: boolean;
  signal?: AbortSignal;
  bindSessionCreation?: SessionEventExecution["bindSessionCreation"];
};

export type InitSessionStateAttemptContext = {
  agentId: string;
  conversationBinding?: SessionBindingRecord;
  conversationBindingContext: ReturnType<typeof resolveSessionConversationBindingContext>;
  isSystemEvent: boolean;
  retargetedSession: boolean;
  sessionKey: string;
  storeWriterIdentity?: string;
  sessionCtxForState: FinalizedRuntimeMsgContext;
  storePath: string;
};

/** Creation facts and their live recipient guard stay with initialization admission. */
export function prepareReplySessionCreation(
  params: InitSessionStateParams,
  target: InitSessionStateAttemptContext,
  entry: SessionEntry | undefined,
) {
  const audience = target.isSystemEvent
    ? undefined
    : capturePrivateConversationCreationAudience({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        entry,
        audience: readConversationPrivateAudience(params.ctx),
      });
  return {
    audience,
    patch: {
      ...(!entry && params.ctx.SessionCreation
        ? buildSessionCreationStamp(params.ctx.SessionCreation)
        : {}),
      ...(audience ? { visibility: "draft" as const } : {}),
    },
    assertCurrent: () => {
      audience?.assertCurrent();
      if (!entry) {
        params.signal?.throwIfAborted();
        assertPreparedSkillLibrarySelection(params.ctx.SessionCreation?.skillLibrarySelections);
      }
    },
  };
}

export async function resolveInitSessionStateAttemptContext(
  params: Pick<InitSessionStateParams, "cfg" | "ctx" | "assertConversationTarget">,
  mode: "preprocessing" | "initialization",
): Promise<InitSessionStateAttemptContext> {
  const { cfg, ctx } = params;
  const {
    isSystemEvent,
    conversationBindingContext,
    commandTargetSessionKey,
    conversationBinding,
  } = await resolveSessionConversationBinding({ cfg, ctx, mode });
  // Escaped ACP commands run under the source model owner. Their handlers resolve
  // the bound target separately; initialization must not mix that key with the source owner.
  const boundSessionKey =
    conversationBinding &&
    !isPluginOwnedSessionBindingRecord(conversationBinding) &&
    !(
      isAcpSessionKey(conversationBinding.targetSessionKey) &&
      shouldBypassAcpDispatchForCommand(ctx, cfg)
    )
      ? readConversationBindingRouteFacts(ctx)?.kind === "agent"
        ? ctx.SessionKey
        : conversationBinding.targetSessionKey
      : undefined;
  const targetSessionKey = commandTargetSessionKey ?? boundSessionKey;
  const sessionCtxForState =
    targetSessionKey && targetSessionKey !== ctx.SessionKey
      ? { ...ctx, SessionKey: targetSessionKey }
      : ctx;
  const agentId = resolveSessionAgentId({
    sessionKey: sessionCtxForState.SessionKey,
    config: cfg,
    fallbackAgentId: sessionCtxForState.AgentId,
  });
  const sessionKey = canonicalizeMainSessionAlias({
    cfg,
    agentId,
    sessionKey: resolveSessionKey(
      cfg.session?.scope ?? "per-sender",
      sessionCtxForState,
      normalizeMainKey(cfg.session?.mainKey),
      agentId,
    ),
  });
  assertExternalConversationTarget({ cfg, agentId, sessionKey, isSystemEvent });
  params.assertConversationTarget?.({ agentId, sessionKey });
  return {
    agentId,
    conversationBinding,
    conversationBindingContext,
    isSystemEvent,
    retargetedSession: sessionCtxForState !== ctx,
    sessionKey,
    sessionCtxForState,
    storePath: resolveSessionStorePathForScope({
      agentId,
      sessionKey: sessionCtxForState.SessionKey,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    }),
  };
}

export function resolveInitializationSessionReader(
  params: InitSessionStateParams,
  attemptContext: InitSessionStateAttemptContext,
) {
  const reader = getReplyOperationSessionReader(params.replyOperation);
  // A bound or command target has its own owner; never redirect the source borrow.
  if (attemptContext.retargetedSession && reader?.sessionKey !== attemptContext.sessionKey) {
    return undefined;
  }
  return reader;
}

/** Admission mapping shared by the pre-effect, restored-snapshot and final commit phases. */
export function resolveInitializationContextSeed(
  params: InitSessionStateParams,
  target: InitSessionStateAttemptContext,
  state?: { entry?: SessionEntry; resetTriggered?: boolean },
) {
  params.assertSourceCurrent?.();
  assertExternalConversationTarget({
    cfg: params.cfg,
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    isSystemEvent: target.isSystemEvent,
    entry: state?.entry,
  });
  return resolveReplyInitialSessionContext({
    initialContext: params.initialSessionContext,
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    entry: state?.entry,
    retargetedSession: target.retargetedSession,
    isSystemEvent: target.isSystemEvent,
    resetTriggered: state?.resetTriggered === true,
    parentSessionKey: normalizeOptionalString(params.ctx.ParentSessionKey),
    modelParentSessionKey: normalizeOptionalString(params.ctx.ModelParentSessionKey),
  });
}

/** Reset hooks and parent forks require hot transcripts before taking the writer lane. */
export async function prepareReplySessionInitialization(
  params: InitSessionStateParams,
  attemptContext: InitSessionStateAttemptContext,
) {
  const reader = resolveInitializationSessionReader(params, attemptContext);
  const assertCurrent = composeSessionSourceAssertion(
    [params.assertSourceCurrent, params.initialSessionContext?.assertCurrent],
    (assertSources) => {
      params.signal?.throwIfAborted();
      reader?.assertCurrent();
      assertSources();
    },
  );
  const parentSessionKey = normalizeOptionalString(params.ctx.ParentSessionKey);
  const snapshot = await loadReplySessionInitializationSnapshot(
    {
      agentId: attemptContext.agentId,
      storePath: attemptContext.storePath,
      sessionKey: attemptContext.sessionKey,
      relatedSessionKeys: parentSessionKey ? [parentSessionKey] : [],
    },
    {
      reader,
      includeColdMetadata: true,
      assertCurrent,
    },
  );
  resolveInitializationContextSeed(params, attemptContext, { entry: snapshot.currentEntry });
  const { restoreSessionColdTranscript } =
    await import("../../config/sessions/session-cold-storage.js");
  const restoreTargets = [
    attemptContext.sessionKey,
    ...(parentSessionKey ? [parentSessionKey] : []),
  ].map((sessionKey) => ({ sessionKey, sessionId: snapshot.readEntry(sessionKey)?.sessionId }));
  for (const { sessionKey, sessionId } of restoreTargets) {
    if (
      sessionId &&
      (snapshot.coldArchives === undefined ||
        snapshot.coldArchives.some((archive) => archive.session_id === sessionId))
    ) {
      assertCurrent();
      await restoreSessionColdTranscript(
        {
          sessionKey,
          sessionId,
          agentId: attemptContext.agentId,
          storePath: attemptContext.storePath,
        },
        assertCurrent,
      );
    }
  }
  assertCurrent();
  return { snapshot, parentSessionKey };
}

export function resolveReplySessionInitializationOptions(
  opts: InternalGetReplyOptions | undefined,
) {
  return {
    assertSourceCurrent: opts?.assertSourceCurrent,
    assertConversationTarget: opts?.assertConversationTarget,
    initialSessionContext: opts?.initialSessionContext,
    providerReviewAcknowledgment: opts?.providerReviewAcknowledgment,
    replyOperation: opts?.replyOperation,
    ...(opts?.expectedExistingSessionId
      ? { expectedExistingSessionId: opts.expectedExistingSessionId }
      : {}),
    pinExpectedExistingSession: opts?.pinExpectedExistingSession === true,
    newlyCreatedSessionId: opts?.newlyCreatedSessionId,
    bindSessionCreation: opts?.internalEventExecution?.bindSessionCreation,
    requestedSessionId: opts?.requestedSessionId,
    resumeRequestedSession: opts?.resumeRequestedSession,
    signal: opts?.abortSignal,
  };
}
