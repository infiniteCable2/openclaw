import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { createConversationKnowledgePrefetchOwner } from "./conversation-knowledge-prefetch-owner.js";
import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";

type Recipient = {
  owner: ReturnType<typeof createConversationKnowledgePrefetchOwner>;
  cache: ReturnType<typeof createConversationKnowledgeSourceCache>;
  retainAudience(audience: ConversationPrivateAudience): void;
};
const log = createSubsystemLogger("conversation-knowledge");
const recipients = resolveGlobalSingleton(
  Symbol.for("openclaw.conversationKnowledgePrefetch"),
  () => new Map<string, Recipient>(),
);

/** Warm active readers and maintain idle history only under a host-confirmed private audience. */
export function prepareConversationKnowledgeRecipient(params: {
  branch: ConversationKnowledgeBranch;
  participant?: SessionParticipantIdentity;
  audience?: ConversationPrivateAudience;
  env: NodeJS.ProcessEnv;
  getRuntimeConfig(): OpenClawConfig;
  run?: RunEmbeddedAgentParams;
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
  let idleRequested = false;
  let idleRequestRevision = 0;
  let idleCompletion: Promise<void> | undefined;
  const checkAudience = () => {
    audience.assertCurrent();
    if (resolveAgentConversationMode(params.getRuntimeConfig(), branch.agentId) !== "branches") {
      throw new Error("Conversation knowledge preparation mode changed");
    }
  };
  checkAudience();
  const requestIdle = (signal: AbortSignal) => {
    idleRequested = true;
    idleRequestRevision++;
    if (idleCompletion) {
      return;
    }
    let attemptedRevision = idleRequestRevision;
    const work = runInDetachedAsyncContext(async () => {
      const { runIdleConversationKnowledge } = await import("./conversation-knowledge-idle.js");
      while (idleRequested && !signal.aborted) {
        idleRequested = false;
        attemptedRevision = idleRequestRevision;
        checkAudience();
        const startedAt = performance.now();
        const result = await runIdleConversationKnowledge({
          branch,
          participant: participant!,
          audience: audience!,
          env: params.env,
          getRuntimeConfig: () => params.getRuntimeConfig(),
          run: params.run,
          signal,
          sourceCache: cache,
        });
        log.debug("Related-history idle admission settled", {
          recipientHash: redactIdentifier(branch.sessionId),
          elapsedMs: Math.round(performance.now() - startedAt),
          admittedPackets: result.admittedPackets,
          status: result.status,
          preempted: result.preempted === true,
        });
        // A new preemptible owner waits for the foreground turn to finish. Read,
        // capacity and authorization failures never become a busy retry loop.
        idleRequested ||= result.preempted === true;
      }
    });
    const settled = work
      .catch(() => {
        // A failed import/read must wait for a genuinely new wakeup, rather
        // than replaying the request that just failed forever.
        idleRequested = idleRequestRevision > attemptedRevision;
        if (!signal.aborted) {
          log.warn("Related-history idle admission deferred; retained progress will resume.");
        }
      })
      .finally(() => {
        if (idleCompletion === settled) {
          idleCompletion = undefined;
        }
        // Preserve a wakeup delivered during the final settlement microtask.
        if (idleRequested && !signal.aborted) {
          requestIdle(signal);
        }
      });
    idleCompletion = settled;
  };
  const owner = createConversationKnowledgePrefetchOwner({
    target: { ...branch, env: params.env },
    assertCurrent: checkAudience,
    clear: () => {
      audiences.clear();
      cache.clear();
      if (recipients.get(key)?.cache === cache) {
        recipients.delete(key);
      }
    },
    onRequest: requestIdle,
    settle: async () => {
      for (let pending = idleCompletion; pending; pending = idleCompletion) {
        await pending;
      }
    },
    async prepare(signal) {
      // Only disposable read-ahead is LRU-bounded. An open recipient's idle
      // catch-up remains registered even when its prepared cache is cold.
      if (![...recipients.keys()].slice(-16).includes(key)) {
        return;
      }
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
          sourceCursor,
        });
        sourceCursor = prepared?.nextSourceCursor;
        log.debug("Related-history source preparation settled", {
          recipientHash: redactIdentifier(branch.sessionId),
          elapsedMs: Math.round(performance.now() - startedAt),
          hasContinuation: sourceCursor !== undefined,
          saturated: prepared?.preparationSaturated === true,
        });
        prepared?.release();
        return sourceCursor !== undefined && !prepared?.preparationSaturated;
      } finally {
        await held.databaseClaim.release();
      }
    },
  });
  const recipient = { owner, cache, retainAudience };
  recipients.set(key, recipient);
  // Evict bytes, not live synchronization: old open branches still follow roots.
  for (const cold of [...recipients.values()].slice(0, -16)) {
    cold.cache.clear();
  }
  return recipient;
}
