import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { registerConversationKnowledgeCheckpointOwner } from "./conversation-knowledge-checkpoint-owner.js";
import { createConversationKnowledgePrefetchOwner } from "./conversation-knowledge-prefetch-owner.js";
import {
  createConversationKnowledgeSourceCache,
  type ConversationKnowledgeSourceCache,
} from "./conversation-knowledge-source-cache.js";

type Recipient = {
  owner: ReturnType<typeof createConversationKnowledgePrefetchOwner>;
  cache: ConversationKnowledgeSourceCache;
  checkpoint: ReturnType<typeof registerConversationKnowledgeCheckpointOwner>;
  retainAudience(audience: ConversationPrivateAudience): void;
};
const log = createSubsystemLogger("conversation-knowledge");
const recipients = resolveGlobalSingleton(
  Symbol.for("openclaw.conversationKnowledgePrefetch"),
  () => new Map<string, Recipient>(),
);

/** Prepare authorized source data without acquiring a model session or changing its history. */
export function prepareConversationKnowledgeRecipient(params: {
  branch: ConversationKnowledgeBranch;
  participant?: SessionParticipantIdentity;
  audience?: ConversationPrivateAudience;
  env: NodeJS.ProcessEnv;
  getRuntimeConfig(): OpenClawConfig;
}): Recipient | undefined {
  const { branch, audience: incomingAudience } = params;
  const participant = params.participant && Object.freeze({ ...params.participant });
  const identity = conversationKnowledgeParticipantIdentity(participant);
  if (
    !incomingAudience ||
    !identity ||
    identity !== conversationKnowledgeParticipantIdentity(incomingAudience.participant) ||
    incomingAudience.agentId !== branch.agentId ||
    incomingAudience.sessionKey !== branch.sessionKey ||
    resolveAgentConversationMode(params.getRuntimeConfig(), branch.agentId) !== "branches"
  ) {
    return undefined;
  }
  const key = JSON.stringify([branch, identity]);
  const old = recipients.get(key);
  if (old) {
    // A second independently admitted endpoint must not inherit the first one's
    // lifetime. A refused incoming proof must not revoke a healthy incumbent.
    old.retainAudience(incomingAudience);
    old.checkpoint.retainAudience(incomingAudience);
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
  const audiences = new Set<ConversationPrivateAudience>();
  const assertAudienceProof = (proof: ConversationPrivateAudience) => {
    proof.assertCurrent();
    if (
      proof.agentId !== branch.agentId ||
      proof.sessionKey !== branch.sessionKey ||
      conversationKnowledgeParticipantIdentity(proof.participant) !== identity
    ) {
      throw new Error("Conversation knowledge recipient proof changed identity");
    }
  };
  const selectAudience = () => {
    let selected: ConversationPrivateAudience | undefined;
    for (const proof of audiences) {
      try {
        assertAudienceProof(proof);
        selected = proof;
      } catch {
        audiences.delete(proof);
      }
    }
    if (!selected) {
      throw new Error("Conversation knowledge recipient has no current private audience");
    }
    return selected;
  };
  const retainAudience = (proof: ConversationPrivateAudience) => {
    assertAudienceProof(proof);
    audiences.delete(proof);
    audiences.add(proof);
    selectAudience();
  };
  retainAudience(incomingAudience);
  // Only independently current, same-person host proofs participate. Matching
  // channel labels or persisted participant metadata never establish authority.
  const audience: ConversationPrivateAudience = Object.freeze({
    agentId: branch.agentId,
    sessionKey: branch.sessionKey,
    participant: participant!,
    get channelId() {
      return selectAudience().channelId;
    },
    get accountId() {
      return selectAudience().accountId;
    },
    get nativeChannelId() {
      return selectAudience().nativeChannelId;
    },
    assertCurrent: () => void selectAudience(),
  });
  const cache = createConversationKnowledgeSourceCache();
  let sourceCursor: string | undefined;
  const checkAudience = () => {
    audience.assertCurrent();
    if (resolveAgentConversationMode(params.getRuntimeConfig(), branch.agentId) !== "branches") {
      throw new Error("Conversation knowledge preparation mode changed");
    }
  };
  checkAudience();
  const checkpoint = registerConversationKnowledgeCheckpointOwner({
    ...params,
    participant: participant!,
    audience,
    onReady: () => recipients.get(key)?.owner.request(),
  });
  const owner = createConversationKnowledgePrefetchOwner({
    target: { ...branch, env: params.env },
    assertCurrent: checkAudience,
    clear: () => {
      audiences.clear();
      cache.clear();
      void checkpoint
        .close()
        .catch(() => log.debug("Related-history checkpoint owner cleanup deferred"));
      if (recipients.get(key)?.cache === cache) {
        recipients.delete(key);
      }
    },
    async prepare(signal) {
      cache.retryCleanup();
      const startedAt = performance.now();
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
          return false;
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
          sourceCursor,
        });
        sourceCursor = prepared?.nextSourceCursor;
        log.debug("Related-history source preparation settled", {
          recipientHash: redactIdentifier(branch.sessionId),
          preparedSourceFrontiers: cache.diagnosticPreparedFrontiers(),
          elapsedMs: Math.round(performance.now() - startedAt),
          hasContinuation: sourceCursor !== undefined,
          saturated: prepared?.preparationSaturated === true,
        });
        prepared?.release();
        const latest = checkpoint.latest();
        if (latest) {
          const { prepareRecipientConversationCheckpoint } =
            await import("./conversation-knowledge-checkpoint-recipient.js");
          await prepareRecipientConversationCheckpoint(
            {
              reader,
              sessionId: branch.sessionId,
              assertCurrent,
              originalParticipant: participant,
              destinationAudience: audience,
              expectedAudienceIdentity: identity,
              getRuntimeConfig: params.getRuntimeConfig,
              signal,
              sourceCache: cache,
              preparationOnly: true,
            },
            latest,
          );
        }
        return sourceCursor !== undefined && !prepared?.preparationSaturated;
      } finally {
        await held.databaseClaim.release();
      }
    },
  });
  const recipient = { owner, cache, checkpoint, retainAudience };
  recipients.set(key, recipient);
  return recipient;
}
