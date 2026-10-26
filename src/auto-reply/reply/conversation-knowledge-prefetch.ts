import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { createConversationKnowledgePrefetchOwner } from "./conversation-knowledge-prefetch-owner.js";
import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";

type Recipient = {
  owner: ReturnType<typeof createConversationKnowledgePrefetchOwner>;
  cache: ReturnType<typeof createConversationKnowledgeSourceCache>;
};
const recipients = resolveGlobalSingleton(
  Symbol.for("openclaw.conversationKnowledgePrefetch"),
  () => new Map<string, Recipient>(),
);

/** Warm only host-confirmed personal recipients; preparation never changes their transcripts. */
export function prepareConversationKnowledgeRecipient(params: {
  branch: ConversationKnowledgeBranch;
  participant?: SessionParticipantIdentity;
  audience?: ConversationPrivateAudience;
  env: NodeJS.ProcessEnv;
  getRuntimeConfig(): OpenClawConfig;
}): Recipient | undefined {
  const { branch, audience } = params;
  const participant = params.participant && Object.freeze({ ...params.participant });
  const identity = conversationKnowledgeParticipantIdentity(participant);
  if (
    !audience ||
    !identity ||
    identity !== conversationKnowledgeParticipantIdentity(audience.participant) ||
    audience.agentId !== branch.agentId ||
    audience.sessionKey !== branch.sessionKey ||
    resolveAgentConversationMode(params.getRuntimeConfig(), branch.agentId) !== "branches"
  ) {
    return undefined;
  }
  const key = JSON.stringify([branch, identity]);
  const old = recipients.get(key);
  if (old) {
    try {
      old.owner.assertCurrent();
      recipients.delete(key);
      recipients.set(key, old);
      // A new admitted input is also a retry opportunity after a transient read failure.
      old.owner.request();
      return old;
    } catch {
      recipients.delete(key);
      void old.owner.close();
    }
  }
  const cache = createConversationKnowledgeSourceCache();
  let sourceOffset = 0;
  const checkAudience = () => {
    audience.assertCurrent();
    if (resolveAgentConversationMode(params.getRuntimeConfig(), branch.agentId) !== "branches") {
      throw new Error("Conversation knowledge preparation mode changed");
    }
  };
  checkAudience();
  const owner = createConversationKnowledgePrefetchOwner({
    target: { ...branch, env: params.env },
    assertCurrent: checkAudience,
    clear: () => cache.clear(),
    async prepare(signal) {
      const held = await loadSessionEntryForAdmission(
        { ...branch, env: params.env },
        { signal, assertCurrent: owner.assertCurrent },
      );
      try {
        owner.assertCurrent();
        const assertCurrent = () => {
          owner.assertCurrent();
          held.databaseClaim.assertCurrent();
        };
        const reader =
          "kind" in held.databaseClaim && held.databaseClaim.kind === "worker"
            ? held.databaseClaim.reader
            : undefined;
        if (
          !reader ||
          held.entry?.sessionId !== branch.sessionId ||
          held.entry.lifecycleRevision !== branch.lifecycleRevision
        ) {
          return;
        }
        const { prepareReplyConversationKnowledge } = await import("./conversation-knowledge.js");
        owner.assertCurrent();
        const prepared = await prepareReplyConversationKnowledge({
          reader,
          sessionId: branch.sessionId,
          assertCurrent,
          originalParticipant: participant,
          destinationAudience: audience,
          expectedAudienceIdentity: identity,
          getRuntimeConfig: () => params.getRuntimeConfig(),
          signal,
          sourceCache: cache,
          preparationOnly: true,
          sourceBudget: 8,
          sourceOffset,
        });
        sourceOffset = prepared?.nextSourceOffset ?? 0;
        if (sourceOffset > 0 && !prepared?.preparationSaturated) {
          owner.request();
        }
        prepared?.release();
      } finally {
        await held.databaseClaim.release();
      }
    },
  });
  const recipient = { owner, cache };
  recipients.set(key, recipient);
  // This bounds disposable preparation, not source history or durable recipient progress.
  while (recipients.size > 16) {
    const oldestKey = recipients.keys().next().value!;
    const oldest = recipients.get(oldestKey)!;
    recipients.delete(oldestKey);
    void oldest.owner.close();
  }
  return recipient;
}
