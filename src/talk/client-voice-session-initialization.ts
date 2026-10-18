import { randomUUID } from "node:crypto";
import type { ChatType } from "../channels/chat-type.js";
import { resolveAgentConversationMode } from "../config/agent-conversation-mode.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "../config/sessions/session-accessor.reset.js";
import { admitSessionConversationBranch } from "../config/sessions/session-conversation-admission.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import {
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type VoiceSessionInitializationParams = {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  cfg?: OpenClawConfig;
  /** Original surface classification, applied only when creating a new native row. */
  chatType?: ChatType;
  deadlineAt?: number;
  assertCommitAllowed?: SessionSourceAssertion;
  creation?: Pick<Parameters<typeof buildSessionCreationStamp>[0], "actor" | "sandbox">;
};

/** Native startup uses the same conversation membership owner as real inbound turns. */
async function ensureConversationBranch(params: VoiceSessionInitializationParams): Promise<string> {
  const cfg = params.cfg!;
  const rootSessionKey = resolveAgentMainSessionKey({ cfg, agentId: params.agentId });
  const storePath = resolveSessionStorePathForScope(params, cfg);
  const assertCurrent = () => {
    params.assertCommitAllowed?.();
    if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
      throw new Error("Realtime browser session expired during startup; try again");
    }
    if (
      cfg.session?.scope === "global" ||
      resolveAgentConversationMode(cfg, params.agentId) !== "branches" ||
      resolveAgentMainSessionKey({ cfg, agentId: params.agentId }) !== rootSessionKey
    ) {
      throw new Error("Talk conversation configuration changed during startup");
    }
  };
  assertCurrent();
  const target = { agentId: params.agentId, sessionKey: params.sessionKey, storePath };
  const snapshot = await loadReplySessionInitializationSnapshot(
    { ...target, relatedSessionKeys: [rootSessionKey] },
    { assertCurrent },
  );
  assertCurrent();
  // In particular, never silently adopt a pre-existing unmarked private history.
  admitSessionConversationBranch({
    ...target,
    currentEntry: snapshot.currentEntry,
    rootSessionKey,
    rootEntry: snapshot.readEntry(rootSessionKey),
  });
  if (snapshot.currentEntry?.sessionId) return snapshot.currentEntry.sessionId;
  const sessionEntry = snapshot.currentEntry
    ? mergeSessionEntry(snapshot.currentEntry, { sessionId: randomUUID() })
    : mergeSessionEntry(undefined, {
        ...buildSessionCreationStamp({
          via: "talk",
          actor: params.creation?.actor ?? { type: "human", source: "unknown" },
          sandbox: params.creation?.sandbox,
        }),
        ...(params.chatType ? { chatType: params.chatType } : {}),
      });
  const source = params.assertCommitAllowed;
  const committed = await commitReplySessionInitialization({
    ...target,
    activeSessionKey: params.sessionKey,
    branchRootSessionKey: rootSessionKey,
    expectedRevision: snapshot.revision,
    sessionEntry,
    commitGuard: assertCurrent,
    // Opaque host cancellation remains a commit guard. Prepared native predicates
    // must also be retained and checked in the existing writer transaction.
    ...(source?.prepareSessionSource && !source.nativeSource
      ? { contextSourceAuthority: source }
      : {}),
  });
  assertCurrent();
  if (!committed.ok) {
    throw new Error("Talk conversation changed during startup; try again");
  }
  return committed.sessionEntry.sessionId;
}

/** Ensure Talk has the same canonical agent-session row that chat turns append to. */
export async function ensureClientVoiceAgentSessionEntry(
  params: VoiceSessionInitializationParams,
): Promise<string> {
  if (params.cfg && resolveAgentConversationMode(params.cfg, params.agentId) === "branches") {
    return ensureConversationBranch(params);
  }
  const commitGuard = sessionEntryCommitGuardOptions(params.assertCommitAllowed);
  const created = await patchSessionEntryCore(
    params,
    (_entry, context) => {
      if (context.existingEntry?.sessionId) return null;
      if (context.existingEntry) return { sessionId: randomUUID() };
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
