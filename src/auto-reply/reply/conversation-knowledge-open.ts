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
import { prepareConversationKnowledgeRecipient } from "./conversation-knowledge-prefetch.js";

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
    return;
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
      return;
    }
    if (held.entry.sessionId !== target.sessionId) {
      throw new Error("Conversation recipient changed before opening");
    }
    const reader =
      "kind" in held.databaseClaim && held.databaseClaim.kind === "worker"
        ? held.databaseClaim.reader
        : undefined;
    if (!reader) {
      return;
    }
    const check = () => {
      assertCurrent();
      held.databaseClaim.assertCurrent();
    };
    const branch = await readConversationKnowledgeBranch({
      reader,
      sessionId: target.sessionId,
      assertCurrent: check,
    });
    check();
    if (!branch) {
      return;
    }
    const seed = await ensureConversationKnowledgeSeed({
      reader,
      sessionId: target.sessionId,
      assertCurrent: check,
      signal: params.signal,
    });
    check();
    if (seed.status === "pending") {
      return;
    }
    prepareConversationKnowledgeRecipient({
      branch,
      participant,
      audience,
      env: reader.database.env,
      getRuntimeConfig: () => params.getRuntimeConfig(),
    });
  } finally {
    await held.databaseClaim.release();
  }
}
