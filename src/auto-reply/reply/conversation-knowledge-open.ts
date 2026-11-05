import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import { ensureConversationKnowledgeSeed } from "../../config/sessions/conversation-knowledge-seed.js";
import {
  readConversationKnowledgeBranch,
  type ConversationKnowledgeBranch,
} from "../../config/sessions/conversation-knowledge-store.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { registerConversationKnowledgeCheckpointOwner } from "./conversation-knowledge-checkpoint-owner.js";
import { prepareConversationKnowledgeRecipient } from "./conversation-knowledge-prefetch.js";

type OpenConversationParams = {
  target: Pick<ConversationKnowledgeBranch, "agentId" | "sessionKey" | "storePath"> & {
    sessionId?: string;
  };
  participant?: SessionParticipantIdentity;
  audience?: ConversationPrivateAudience;
  getRuntimeConfig(): OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onReady?: () => void;
};

/** Restore preparation for an existing private endpoint, without creating a conversation or input. */
export async function openConversationKnowledgeRoot(params: OpenConversationParams) {
  let registration: ReturnType<typeof registerConversationKnowledgeCheckpointOwner> | undefined;
  try {
    const enrollment = await openConversationKnowledge(params, true, (value) => {
      registration = value;
    });
    params.signal?.throwIfAborted();
    params.audience?.assertCurrent();
    // The root prepares shared bytes; the existing recipient owner prepares its
    // independently authorized view. Neither needs a first input or a token budget.
    // Native model capacity still governs eventual transcript admission.
    if (enrollment) {
      prepareConversationKnowledgeRecipient(enrollment);
    }
    return registration;
  } catch (error) {
    await registration?.close();
    throw error;
  }
}

/**
 * Open an already materialized recipient without manufacturing a user input.
 * The caller retains its connection/channel audience; this operation releases only its reader.
 */
export async function openConversationKnowledgeRecipient(params: {
  target: Pick<ConversationKnowledgeBranch, "agentId" | "sessionKey" | "storePath" | "sessionId">;
  participant?: SessionParticipantIdentity;
  audience?: ConversationPrivateAudience;
  getRuntimeConfig(): OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<void> {
  await openConversationKnowledge(params, false);
}

async function openConversationKnowledge(
  params: OpenConversationParams,
  rootOnly: boolean,
  retainRoot?: (value: ReturnType<typeof registerConversationKnowledgeCheckpointOwner>) => void,
) {
  const target = { ...params.target };
  const { audience, participant } = params;
  const identity = participant && conversationKnowledgeParticipantIdentity(participant);
  if (
    !audience ||
    !identity ||
    identity !== conversationKnowledgeParticipantIdentity(audience.participant) ||
    audience.agentId !== target.agentId ||
    audience.sessionKey !== target.sessionKey ||
    resolveAgentConversationMode(params.getRuntimeConfig(), target.agentId) !== "branches"
  ) {
    return undefined;
  }
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    audience.assertCurrent();
    if (resolveAgentConversationMode(params.getRuntimeConfig(), target.agentId) !== "branches") {
      throw new Error("Conversation mode changed while opening its recipient");
    }
  };
  assertCurrent();
  const held = await loadSessionEntryForAdmission(
    { ...target, env: params.env },
    { assertCurrent, signal: params.signal },
  );
  try {
    assertCurrent();
    held.databaseClaim.assertCurrent();
    if (!held.entry) {
      return undefined;
    }
    if (target.sessionId !== undefined && held.entry.sessionId !== target.sessionId) {
      throw new Error("Conversation recipient changed before opening");
    }
    if (rootOnly) {
      // Current host custody selects the person. A historical roster can contain
      // pre-link identities; preparing that person's existing root partition does
      // not seed, relabel, or authorize any of those older contributions.
      if (
        held.entry.visibility !== "draft" ||
        held.entry.incognito ||
        held.entry.publicShare !== undefined ||
        held.entry.archivedAt !== undefined
      ) {
        return undefined;
      }
    }
    const reader =
      "kind" in held.databaseClaim && held.databaseClaim.kind === "worker"
        ? held.databaseClaim.reader
        : undefined;
    if (!reader) {
      return undefined;
    }
    const check = () => {
      assertCurrent();
      held.databaseClaim.assertCurrent();
    };
    const branch = await readConversationKnowledgeBranch({
      reader,
      sessionId: held.entry.sessionId,
      assertCurrent: check,
    });
    check();
    if (!branch) {
      return undefined;
    }
    const enrollment = {
      branch,
      participant,
      audience,
      env: reader.database.env,
      getRuntimeConfig: () => params.getRuntimeConfig(),
    };
    if (rootOnly) {
      // Historical enrollment stays with its native seed owner. Restore only
      // preparation over existing references; do not backfill dialogue.
      retainRoot?.(
        registerConversationKnowledgeCheckpointOwner({
          ...enrollment,
          participant: participant!,
          onReady: params.onReady,
        }),
      );
      return enrollment;
    }
    const seed = await ensureConversationKnowledgeSeed({
      reader,
      sessionId: held.entry.sessionId,
      assertCurrent: check,
      signal: params.signal,
    });
    check();
    if (seed.status === "pending") {
      return undefined;
    }
    prepareConversationKnowledgeRecipient(enrollment);
    return undefined;
  } finally {
    await held.databaseClaim.release();
  }
}
