import { randomUUID } from "node:crypto";
import type { ChatType } from "../channels/chat-type.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import { createRuntimeConfigReader } from "../config/runtime-snapshot.js";
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
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
  type SessionSourceTransactionGrant,
} from "../config/sessions/session-source-authority.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
export async function initializePreparedVoiceConversation(
  params: VoiceSessionInitializationParams & {
    cfg: OpenClawConfig;
    creationSource?: SessionSourceTransactionGrant;
    activationSource?: SessionSourceAssertion;
  },
): Promise<string | undefined> {
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
    params.assertCurrent?.();
    params.assertCommitAllowed?.();
    if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
      throw new Error("Realtime browser session expired during startup; try again");
    }
    const currentConfig = getRuntimeConfig();
    if (
      (rootSessionKey && currentConfig.session?.scope === "global") ||
      resolveAgentConversationMode(currentConfig, params.agentId) !== mode ||
      (rootSessionKey &&
        resolveAgentConversationRootSessionKey({ cfg: currentConfig, agentId: params.agentId }) !==
          rootSessionKey)
    ) {
      throw new Error("Talk conversation configuration changed during startup");
    }
  };
  assertCurrent();
  const { prepareSessionConversationActivation } =
    await import("../config/sessions/session-conversation-activation.js");
  const activate = () =>
    prepareSessionConversationActivation({
      ...params,
      cfg,
      storePath,
      getConfig: getRuntimeConfig,
      assertCurrent: composeSessionSourceAssertion(
        [params.activationSource ?? params.source],
        (check) => {
          assertCurrent();
          check();
        },
      ),
    });
  await activate();
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
  if (snapshot.currentEntry) {
    // Reuse goes through the native ensure-identity transaction, including its
    // no-op authorization. A read snapshot is not a write grant.
    return undefined;
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
  const source = params.source;
  const generation = !snapshot.currentEntry
    ? await prepareSessionGenerationFacts({ ...target, sessionId: null, lifecycleRevision: null })
    : undefined;
  try {
    assertCurrent();
    generation?.assertCurrent();
    const committed = await commitReplySessionInitialization({
      ...target,
      databaseSource: snapshot.databaseSource,
      creationSource: params.creationSource,
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
      ...(source?.prepareSessionSource ? { contextSourceAuthority: source } : {}),
    });
    assertCurrent();
    generation?.assertCurrent();
    if (!committed.ok || (generation && !generation.isCreationAdopted())) {
      throw new Error("Talk conversation changed during startup; try again");
    }
    await activate();
    return committed.sessionEntry.sessionId;
  } finally {
    generation?.release();
  }
}

/** Compatibility entry: native preparation remains the sole physical-store owner. */
export async function ensureClientVoiceAgentSessionEntry(
  params: VoiceSessionInitializationParams,
): Promise<string> {
  const native = await import("./client-voice-session-write.js");
  return native.ensureClientVoiceAgentSessionEntry(params);
}
