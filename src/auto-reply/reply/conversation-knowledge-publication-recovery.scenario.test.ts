import "../../test-utils/prepare-compiled-subprocesses.js";
import { isMainThread } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { resolveEmbeddedSessionContextLimits } from "../../agents/embedded-agent-runner/run/session-context-limits.js";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  conversationKnowledgeContributionId,
} from "../../config/sessions/conversation-knowledge-packets.js";
import {
  prepareConversationKnowledgeRootSubset,
  readConversationKnowledgeBranch,
  readPreparedConversationKnowledgeRoot,
  recordConversationKnowledgeTurn,
} from "../../config/sessions/conversation-knowledge-store.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { getSessionEntryPatchDelivery } from "../../config/sessions/session-entry-patch-delivery.test-support.js";
import { addSessionMemberInWorker } from "../../config/sessions/session-sharing-store.async.js";
import { SessionMutationFactsUnavailableError } from "../../gateway/session-sharing-incognito.js";
import { prepareTranscriptReadAuthority } from "../../gateway/session-transcript-read-authority.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareRecipientConversationProjection } from "./conversation-knowledge-checkpoint-recipient.js";
import { createConversationKnowledgePrefetchOwner } from "./conversation-knowledge-prefetch-owner.js";
import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";

// Real native source groups, SQLite publications and packet imports; only writer
// result delivery and the prefetch retry clock are held at existing test seams.
it("imports a cached donor group after transient publication without another user turn", async ({
  signal,
}) => {
  expect(isMainThread).toBe(true);
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createConversationKnowledgeScenario(state);
    const cache = createConversationKnowledgeSourceCache();
    const delivery = getSessionEntryPatchDelivery();
    const committed = createDeferredCore();
    const releaseDelivery = createDeferredCore();
    let mutation: Promise<unknown> | undefined;
    let prefetch: ReturnType<typeof createConversationKnowledgePrefetchOwner> | undefined;
    let probe: ReturnType<typeof sqliteWorkerOwnerProbe.admission> | undefined;
    type Grant = Awaited<ReturnType<typeof prepareTranscriptReadAuthority>>;
    let originalGrant: Grant | undefined;
    let recoveredGrant: Grant | undefined;
    try {
      const donor = await fixture.branch("publication-donor");
      const donorOwner = await fixture.claim(donor);
      for (const runId of ["publication-one", "publication-two"]) {
        const terminal = await fixture.append(donor, runId);
        if (!terminal.admission) {
          throw new Error("Native donor admission unavailable");
        }
        expect(
          await recordConversationKnowledgeTurn({
            ...donorOwner,
            ...terminal,
            privateAudience: { participant: person, admission: terminal.admission },
          }),
        ).toBe(true);
      }
      const recipient = await fixture.branch("publication-recipient");
      const principal = await fixture.claim(recipient);
      const audience: ConversationPrivateAudience = {
        agentId: recipient.agentId,
        sessionKey: recipient.sessionKey,
        channelId: "test",
        accountId: "default",
        nativeChannelId: "native-publication-recipient",
        participant: person,
        // Host identity outlives an individual source read, as on real ingress.
        assertCurrent: principal.assertCurrent,
      };
      const params = {
        ...principal,
        signal,
        originalParticipant: person,
        destinationAudience: audience,
        expectedAudienceIdentity: conversationKnowledgeParticipantIdentity(person),
        getRuntimeConfig: () => fixture.cfg,
        sourceCache: cache,
        preparationOnly: true,
      };
      const initial = await prepareReplyConversationKnowledge(params);
      initial?.release();
      const references = await fixture.receipts();
      expect(references).toHaveLength(2);
      const tail = references.map((reference) => {
        const packet = cache.peek(conversationKnowledgeContributionId(reference), 0);
        if (!packet) {
          throw new Error("Native prepared donor packet unavailable");
        }
        return { reference, packet };
      });
      expect(await prepareRecipientConversationProjection(params, tail)).toBe(true);
      const branch = await readConversationKnowledgeBranch(principal);
      if (!branch) {
        throw new Error("Native recipient branch unavailable");
      }
      const acquireCachedGrant = async () => {
        const manifest = cache.preparedRoot;
        const group = manifest && cache.preparedContributionGroup(donor, manifest);
        const sourceManifest = manifest && cache.preparedContributionGroupManifest(donor, manifest);
        if (!manifest || !group || !sourceManifest) {
          throw new Error("Native cached donor group unavailable");
        }
        const selected = await readPreparedConversationKnowledgeRoot({
          ...params,
          branch,
          manifest,
        });
        const subset = prepareConversationKnowledgeRootSubset({
          evidence: selected.evidence,
          branch,
          manifest: sourceManifest,
        });
        return prepareTranscriptReadAuthority({
          purpose: "conversation-differences",
          personal: {
            originalParticipant: person,
            assertCurrent: principal.assertCurrent,
            target: branch,
            targetAudience: audience,
            rootEvidence: subset.evidence,
            contributionGroup: group,
          },
          getRuntimeConfig: () => fixture.cfg,
          sources: [donor],
          signal,
        });
      };
      originalGrant = await acquireCachedGrant();
      const heldGrant = originalGrant;
      heldGrant.assertCurrent();
      const readPackets = async () =>
        (await loadTranscriptEvents(recipient))
          .map(asOptionalRecord)
          .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT);
      expect(await readPackets()).toHaveLength(0);
      let pendingRead: Promise<void> | undefined;
      let deferredFailure: unknown;
      let importRequested = false;
      let successfulImports = 0;
      let cleared = 0;
      const readCachedGrant = async () => heldGrant.assertCurrent();
      const owner = createConversationKnowledgePrefetchOwner({
        target: { ...recipient, root: branch.root },
        assertCurrent: principal.assertCurrent,
        watchesSource: (sessionKey) => sessionKey === donor.sessionKey,
        async prepare() {
          const captured = pendingRead;
          pendingRead = undefined;
          if (captured) {
            try {
              await captured;
            } catch (error) {
              deferredFailure = error;
              throw error;
            }
          }
          if (!importRequested) {
            return;
          }
          expect(await prepareRecipientConversationProjection(params, tail)).toBe(true);
          recoveredGrant = await acquireCachedGrant();
          recoveredGrant.assertCurrent();
          const imported = await prepareReplyConversationKnowledge({
            ...params,
            preparationOnly: false,
            readyOnly: true,
            retainInHistory: {
              writeTarget: recipient,
              contextLimits: resolveEmbeddedSessionContextLimits(1_000_000),
              maintainContext: async (source) => {
                source();
                return { compacted: false, complete: true, canAdmitPending: true };
              },
            },
          });
          try {
            expect(imported).toBeDefined();
            expect(imported?.pendingPackets).toBe(false);
            imported?.assertCurrent();
          } finally {
            imported?.release();
          }
          importRequested = false;
          successfulImports++;
        },
        clear() {
          cleared++;
        },
      });
      prefetch = owner;
      await withinTest(owner.wait(), signal);
      let commitGrants = 0;
      probe = sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
        if (request.stage !== "commit" || commitGrants > 0) {
          admit(request, grant);
          return;
        }
        admit(request, (beforeRelease) => {
          commitGrants++;
          // Capture the actual cached group's synchronous refusal inside the
          // real pending writer grant; async delivery may outlive this stack.
          pendingRead = readCachedGrant();
          void pendingRead.catch(() => {});
          owner.request();
          return grant(beforeRelease);
        });
      });
      delivery.afterCommit = async () => {
        committed.resolve();
        await releaseDelivery.promise;
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      importRequested = true;
      mutation = applySessionEntryOperation(
        donor,
        {
          kind: "fields",
          expected: { sessionId: donor.sessionId, lifecycleRevision: donor.lifecycleRevision },
          patch: { activeWriterRunId: "publication-next-writer" },
        },
        { skipMaintenance: true },
      );
      void mutation.catch(() => {});
      await withinTest(
        awaitGateBeforeSettlement(committed.promise, mutation, "Donor missed native COMMIT gate"),
        signal,
      );
      await withinTest(owner.wait(), signal);
      expect(commitGrants).toBe(1);
      expect(deferredFailure).toBeInstanceOf(SessionMutationFactsUnavailableError);
      expect(deferredFailure).toMatchObject({
        diagnostic: { reason: "retained-read-unavailable", publicationPending: true },
      });
      expect(successfulImports).toBe(0);
      expect(cleared).toBe(0);
      expect(() => owner.assertCurrent()).not.toThrow();
      expect(await readPackets()).toHaveLength(0);

      // No explicit wakeup, user turn or timer advancement follows this release.
      // The normal native publication must resume the original prefetch owner.
      releaseDelivery.resolve();
      await withinTest(mutation, signal);
      probe.mockRestore();
      probe = undefined;
      delivery.afterCommit = undefined;
      await withinTest(owner.wait(), signal);
      expect(successfulImports).toBe(1);
      expect(cleared).toBe(0);
      const packets = await readPackets();
      expect(packets).toHaveLength(2);
      expect(JSON.stringify(packets)).toContain("publication-one answer");
      expect(JSON.stringify(packets)).toContain("publication-two answer");
      expect(() => heldGrant.assertCurrent()).toThrow(SessionMutationFactsUnavailableError);

      // Fresh custody may recover, but genuine source disclosure changes still
      // revoke a current grant. Existing copied recipient history stays intact.
      if (!recoveredGrant) {
        throw new Error("Autonomously recovered source grant unavailable");
      }
      recoveredGrant.assertCurrent();
      const outsider = ensureProfileForEmail("publication-outsider@example.test");
      await addSessionMemberInWorker(donor, { identityId: outsider.id, addedBy: outsider.id });
      const currentGrant = recoveredGrant;
      expect(() => currentGrant.assertCurrent()).toThrow();
      await withinTest(owner.wait(), signal);
      expect(await readPackets()).toEqual(packets);
    } finally {
      releaseDelivery.resolve();
      try {
        await mutation;
      } finally {
        probe?.mockRestore();
        delivery.afterCommit = undefined;
        try {
          await prefetch?.close();
        } finally {
          vi.useRealTimers();
          try {
            recoveredGrant?.release();
          } finally {
            try {
              originalGrant?.release();
            } finally {
              try {
                cache.clear();
              } finally {
                await fixture.close();
              }
            }
          }
        }
      }
    }
  });
});
