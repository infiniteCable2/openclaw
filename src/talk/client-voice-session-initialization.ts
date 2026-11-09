import { randomUUID } from "node:crypto";
import type { ChatType } from "../channels/chat-type.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import { createRuntimeConfigReader } from "../config/runtime-snapshot.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "../config/sessions/session-accessor.reset.js";
import type { SessionEntryCreationOperation } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { admitSessionConversationBranch } from "../config/sessions/session-conversation-admission.js";
import { resolveAgentConversationRootSessionKey } from "../config/sessions/session-conversation-root-key.js";
import { prepareSessionGenerationFacts } from "../config/sessions/session-delivery-generation.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import {
  sessionEntryCommitGuardOptions,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSubagentSessionKey, isIncognitoSessionKey } from "../routing/session-key.js";
import {
  capturePrivateConversationCreationAudience,
  type ConversationPrivateAudience,
} from "../sessions/conversation-private-audience.js";

export type VoiceSessionInitializationParams = {
  requester?: SessionSourceAssertion;
  source?: SessionSourceAssertion;
  assertCurrent?: () => void;
  prepareWorkerGrant?: () => Promise<
    import("../config/sessions/session-source-authority.js").SessionSourceWriteGrant
  >;
  onCommitted?: (entry: import("../config/sessions/types.js").InternalSessionEntry) => void;
  onCommittedSource?: (
    source: import("../config/sessions/session-entry-read-source.types.js").CapturedSessionEntryReadSource,
    entry: import("../config/sessions/types.js").InternalSessionEntry,
  ) => void;
  agentId: string;
  sessionKey: string;
  storePath?: string;
  cfg?: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig;
  /** Original surface classification, applied only when creating a new native row. */
  chatType?: ChatType;
  /** Original host recipient proof; only new conversations can become private. */
  privateAudience?: ConversationPrivateAudience;
  deadlineAt?: number;
  assertCommitAllowed?: SessionSourceAssertion;
  /** Actual native creation publication, never a proposed ID or a reloaded row. */
  onCreatedSessionCommitted?: (target: {
    agentId: string;
    sessionKey: string;
    storePath: string;
    sessionId: string;
    lifecycleRevision?: string;
  }) => void;
  creation?: Pick<Parameters<typeof buildSessionCreationStamp>[0], "actor" | "sandbox">;
};

/** Native startup uses the same conversation membership owner as real inbound turns. */
async function ensureConversationSession(
  params: VoiceSessionInitializationParams & { cfg: OpenClawConfig },
): Promise<string> {
  const cfg = params.cfg;
  const getRuntimeConfig =
    params.getRuntimeConfig ?? createRuntimeConfigReader(cfg, { capture: true });
  const mode = resolveAgentConversationMode(cfg, params.agentId);
  const rootSessionKey =
    mode === "branches"
      ? resolveAgentConversationRootSessionKey({ cfg, agentId: params.agentId })
      : undefined;
  const storePath = resolveSessionStorePathForScope(params, cfg);
  const assertCurrent = () => {
    params.assertCommitAllowed?.();
    if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
      throw new Error("Realtime browser session expired during startup; try again");
    }
    if (
      (rootSessionKey && cfg.session?.scope === "global") ||
      resolveAgentConversationMode(cfg, params.agentId) !== mode ||
      (rootSessionKey &&
        resolveAgentConversationRootSessionKey({ cfg, agentId: params.agentId }) !== rootSessionKey)
    ) {
      throw new Error("Talk conversation configuration changed during startup");
    }
  };
  assertCurrent();
  const target = { agentId: params.agentId, sessionKey: params.sessionKey, storePath };
  const snapshot = await loadReplySessionInitializationSnapshot(
    { ...target, relatedSessionKeys: rootSessionKey ? [rootSessionKey] : [] },
    { assertCurrent },
  );
  assertCurrent();
  if (rootSessionKey) {
    // Existing history must have completed exact enrollment before this owner.
    admitSessionConversationBranch({
      ...target,
      currentEntry: snapshot.currentEntry,
      rootSessionKey,
      rootEntry: snapshot.readEntry(rootSessionKey),
    });
  }
  if (snapshot.currentEntry?.sessionId) {
    return snapshot.currentEntry.sessionId;
  }
  const privateAudience = capturePrivateConversationCreationAudience({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    entry: snapshot.currentEntry,
    audience: params.privateAudience,
  });
  const sessionEntry = snapshot.currentEntry
    ? mergeSessionEntry(snapshot.currentEntry, { sessionId: randomUUID() })
    : mergeSessionEntry(undefined, {
        ...buildSessionCreationStamp({
          via: "talk",
          actor: params.creation?.actor ?? { type: "human", source: "unknown" },
          sandbox: params.creation?.sandbox,
        }),
        lifecycleRevision: randomUUID(),
        ...(params.chatType ? { chatType: params.chatType } : {}),
        ...(privateAudience ? { visibility: "draft" as const } : {}),
      });
  const source = params.assertCommitAllowed;
  const generation = !snapshot.currentEntry
    ? await prepareSessionGenerationFacts({ ...target, sessionId: null, lifecycleRevision: null })
    : undefined;
  try {
    assertCurrent();
    generation?.assertCurrent();
    const committed = await commitReplySessionInitialization({
      ...target,
      activeSessionKey: params.sessionKey,
      ...(rootSessionKey ? { branchRootSessionKey: rootSessionKey } : {}),
      expectedRevision: snapshot.revision,
      sessionEntry,
      ...(rootSessionKey && privateAudience
        ? {
            prepareInitialContext: async (entry: typeof sessionEntry) => {
              const { prepareConversationKnowledgeInitialContext } =
                await import("../auto-reply/reply/conversation-knowledge-initial-context.js");
              return prepareConversationKnowledgeInitialContext({
                ...target,
                sessionEntry: entry,
                cfg,
                getRuntimeConfig,
                audience: privateAudience,
                assertCurrent,
              });
            },
          }
        : {}),
      onCreated: (created) => {
        params.onCommitted?.(created.entry);
        params.onCommittedSource?.(created.readSource, created.entry);
      },
      commitGuard: () => {
        assertCurrent();
        privateAudience?.assertCurrent();
      },
      // The existing generation owner binds only this creation operation's settled
      // COMMIT receipt. It updates the request's absence before later source checks.
      ...(generation
        ? {
            bindCreation: (operation: SessionEntryCreationOperation) =>
              generation.bindCreation(operation, (binding) =>
                params.onCreatedSessionCommitted?.({ ...target, ...binding }),
              ),
          }
        : {}),
      // Opaque host cancellation remains a commit guard. Prepared native predicates
      // must also be retained and checked in the existing writer transaction.
      ...(source?.prepareSessionSource && !source.nativeSource
        ? { contextSourceAuthority: source }
        : {}),
    });
    assertCurrent();
    generation?.assertCurrent();
    if (!committed.ok || (generation && !generation.isCreationAdopted())) {
      throw new Error("Talk conversation changed during startup; try again");
    }
    return committed.sessionEntry.sessionId;
  } finally {
    generation?.release();
  }
}

/** Ensure Talk has the same canonical agent-session row that chat turns append to. */
export async function ensureClientVoiceAgentSessionEntry(
  input: VoiceSessionInitializationParams,
): Promise<string> {
  // This generic creation path copies root context atomically through the native
  // session initializer. Retain the caller's full read grant across preparation.
  const grant = await input.prepareWorkerGrant?.();
  const params: VoiceSessionInitializationParams = {
    ...input,
    assertCommitAllowed: composeSessionSourceAssertion(
      [input.assertCommitAllowed, input.requester, input.source],
      (check) => {
        input.assertCurrent?.();
        grant?.assertCurrent();
        check();
      },
    ),
  };
  try {
    return await ensureConversationEntry(params);
  } finally {
    await grant?.release();
  }
}

async function ensureConversationEntry(params: VoiceSessionInitializationParams): Promise<string> {
  if (
    params.cfg &&
    !isSubagentSessionKey(params.sessionKey) &&
    !isIncognitoSessionKey(params.sessionKey)
  ) {
    const { prepareSessionConversationActivation } =
      await import("../config/sessions/session-conversation-activation.js");
    await prepareSessionConversationActivation({
      ...params,
      cfg: params.cfg,
      storePath: resolveSessionStorePathForScope(params, params.cfg),
      assertCurrent: composeSessionSourceAssertion([params.assertCommitAllowed], (check) => {
        check();
        if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
          throw new Error("Realtime browser session expired during startup; try again");
        }
      }),
    });
  }
  if (params.cfg) {
    const sessionId = await ensureConversationSession({ ...params, cfg: params.cfg });
    // First creation has no row for the preflight enrollment helper. Establish
    // the empty/history seed barrier before any realtime utterance can publish.
    const { prepareSessionConversationActivation } =
      await import("../config/sessions/session-conversation-activation.js");
    if (!isSubagentSessionKey(params.sessionKey) && !isIncognitoSessionKey(params.sessionKey)) {
      await prepareSessionConversationActivation({
        ...params,
        cfg: params.cfg,
        storePath: resolveSessionStorePathForScope(params, params.cfg),
        assertCurrent: composeSessionSourceAssertion([params.assertCommitAllowed], (check) => {
          check();
          if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
            throw new Error("Realtime browser session expired during startup; try again");
          }
        }),
      });
    }
    return sessionId;
  }
  const commitGuard = sessionEntryCommitGuardOptions(params.assertCommitAllowed);
  const created = await patchSessionEntryCore(
    params,
    (_entry, context) => {
      if (context.existingEntry?.sessionId) {
        return null;
      }
      if (context.existingEntry) {
        return { sessionId: randomUUID() };
      }
      return {
        ...buildSessionCreationStamp({
          via: "talk",
          actor: params.creation?.actor ?? { type: "human", source: "unknown" },
          sandbox: params.creation?.sandbox,
        }),
        ...(params.chatType ? { chatType: params.chatType } : {}),
      };
    },
    {
      fallbackEntry: mergeSessionEntry(undefined, {}),
      ...commitGuard,
      workerGuard: {
        ...commitGuard.workerGuard,
        assertCurrent: () => {
          if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
            throw new Error("Realtime browser session expired during startup; try again");
          }
        },
      },
    },
  );
  if (!created?.sessionId) {
    throw new Error(`agent session could not be initialized (${params.sessionKey})`);
  }
  return created.sessionId;
}
