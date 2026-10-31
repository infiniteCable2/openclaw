import "../../test-utils/prepare-compiled-subprocesses.js";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-packets.js";
import {
  readConversationKnowledgeBranch,
  readPreparedConversationKnowledgeRoot,
  prepareConversationKnowledgeRootSubset,
  recordConversationKnowledgeTurn,
} from "../../config/sessions/conversation-knowledge-store.js";
import { readConversationKnowledgeReceipt } from "../../config/sessions/conversation-knowledge.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMemberInWorker } from "../../config/sessions/session-sharing-store.async.js";
import * as transcriptContext from "../../config/sessions/session-transcript-context-read.js";
import * as personalRead from "../../gateway/session-transcript-personal-read.js";
import * as transcriptAuthority from "../../gateway/session-transcript-read-authority.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareRecipientConversationProjection } from "./conversation-knowledge-checkpoint-recipient.js";
import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "./conversation-knowledge.scenario.test-support.js";

// Native SQLite, compiled workers, source grants and permission publications all
// run unchanged. Spies below only observe original calls, results and errors.
it("renews one stale recipient group from prepared bytes and still refuses a newly shared source", async ({
  signal,
}) => {
  const began = performance.now();
  await withOpenClawTestState(
    { scenario: "minimal", label: "recipient-metadata-rebind" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      const cache = createConversationKnowledgeSourceCache();
      const probes: Array<{ mockRestore(): void }> = [];
      try {
        const donor = await fixture.branch("rebind-donor");
        const donorOwner = await fixture.claim(donor);
        for (const runId of ["rebind-one", "rebind-two", "rebind-three"]) {
          const terminal = await fixture.append(donor, runId);
          if (!terminal.admission) {
            throw new Error("Native source admission unavailable");
          }
          expect(
            await recordConversationKnowledgeTurn({
              ...donorOwner,
              ...terminal,
              privateAudience: { participant: person, admission: terminal.admission },
            }),
          ).toBe(true);
        }
        const target = await fixture.branch("rebind-recipient");
        const owner = await fixture.claim(target);
        const audience: ConversationPrivateAudience = {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          channelId: "test",
          accountId: "default",
          nativeChannelId: "native-rebind-recipient",
          participant: person,
          assertCurrent: owner.assertCurrent,
        };
        const params = {
          ...owner,
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
        const references = (await loadTranscriptEvents(fixture.root)).flatMap((raw) => {
          const receipt = readConversationKnowledgeReceipt(asOptionalRecord(raw)?.details);
          return receipt ? [receipt] : [];
        });
        expect(references).toHaveLength(3);
        const tail = references.map((reference) => {
          const packet = cache.peek(conversationKnowledgeContributionId(reference), 0);
          if (!packet) {
            throw new Error("Native prepared original unavailable");
          }
          return { reference, packet };
        });
        const preparation = new AbortController();
        expect(
          await prepareRecipientConversationProjection(
            { ...params, signal: preparation.signal },
            tail,
          ),
        ).toBe(true);
        const manifest = cache.preparedRoot!;
        const old = cache.preparedContributionGroup(donor, manifest);
        expect(old).toBeDefined();
        const prepareGroup = vi.spyOn(personalRead, "preparePersonalConversationContributionGroup");
        const readAuthority = vi.spyOn(transcriptAuthority, "prepareTranscriptReadAuthority");
        const singleContext = vi.spyOn(transcriptContext, "readSessionTranscriptModelContextAsync");
        const batchContext = vi.spyOn(transcriptContext, "readSessionTranscriptModelContextsAsync");
        probes.push(prepareGroup, readAuthority, singleContext, batchContext);
        preparation.abort();
        expect(await prepareRecipientConversationProjection(params, tail)).toBe(true);
        expect(cache.preparedContributionGroup(donor, manifest)).toBe(old);
        expect(prepareGroup).not.toHaveBeenCalled();
        expect(readAuthority).toHaveBeenCalledOnce();
        prepareGroup.mockClear();
        readAuthority.mockClear();

        // Native row publication updates held facts. Old custody must be refused,
        // then renewed once for all three ranges, without reading donor text again.
        await upsertSessionEntryCore(target, {
          ...loadSessionEntry(target)!,
          delivery: { kind: "internal" },
        });
        expect(await prepareRecipientConversationProjection(params, tail)).toBe(true);
        const current = cache.preparedContributionGroup(donor, manifest);
        expect(current).toBeDefined();
        if (!current) {
          throw new Error("Renewed native source custody unavailable");
        }
        expect(current).not.toBe(old);
        expect(prepareGroup).toHaveBeenCalledOnce();
        expect(readAuthority).toHaveBeenCalledTimes(2);
        const branch = await readConversationKnowledgeBranch(owner);
        if (!branch) {
          throw new Error("Native recipient branch unavailable");
        }
        const selected = await readPreparedConversationKnowledgeRoot({
          ...params,
          branch,
          manifest,
        });
        const sourceManifest = cache.preparedContributionGroupManifest(donor, manifest);
        if (!sourceManifest) {
          throw new Error("Native donor subset unavailable");
        }
        const subset = prepareConversationKnowledgeRootSubset({
          evidence: selected.evidence,
          branch,
          manifest: sourceManifest,
        });
        const grant = await transcriptAuthority.prepareTranscriptReadAuthority({
          purpose: "conversation-differences",
          personal: {
            originalParticipant: person,
            assertCurrent: owner.assertCurrent,
            target: branch,
            targetAudience: audience,
            rootEvidence: subset.evidence,
            contributionGroup: current,
          },
          getRuntimeConfig: () => fixture.cfg,
          sources: [donor],
          signal,
        });
        try {
          expect(
            references.filter((reference) => Boolean(grant.selectContribution(reference))),
          ).toHaveLength(3);
          grant.assertCurrent();
        } finally {
          grant.release();
        }

        // A real foreign-reader COMMIT revokes private automatic disclosure.
        // Renewing metadata is never permission to keep or widen the old grant.
        const other = ensureProfileForEmail("other-reader@example.test");
        await addSessionMemberInWorker(donor, { identityId: other.id, addedBy: other.id });
        expect(await prepareRecipientConversationProjection(params, tail)).toBe(false);
        expect(cache.preparedContributionGroup(donor, manifest)).toBeUndefined();
        expect(
          singleContext.mock.calls.filter(([scope]) => scope.sessionId === donor.sessionId),
        ).toHaveLength(0);
        expect(
          batchContext.mock.calls.filter(([scope]) => scope.sessionId === donor.sessionId),
        ).toHaveLength(0);
      } finally {
        for (const probe of probes.toReversed()) {
          probe.mockRestore();
        }
        try {
          cache.clear();
        } finally {
          await fixture.close();
        }
      }
    },
  );
  console.info(
    JSON.stringify({
      scenario: "recipient-native-custody-rebind",
      elapsedMs: Math.round(performance.now() - began),
      sourceGroups: 1,
      originalRanges: 3,
      donorContentReadsDuringRebind: 0,
    }),
  );
});

it("refreshes only the changed donor and keeps independent native custody for a third recipient", async ({
  signal,
}) => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "recipient-donor-subsets" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      const cache = createConversationKnowledgeSourceCache(),
        otherCache = createConversationKnowledgeSourceCache(),
        stagingCache = createConversationKnowledgeSourceCache();
      const probes: Array<{ mockRestore(): void }> = [];
      try {
        const donorA = await fixture.branch("subset-a"),
          donorB = await fixture.branch("subset-b");
        const ownerA = await fixture.claim(donorA),
          ownerB = await fixture.claim(donorB);
        const record = async (donor: typeof donorA, owner: typeof ownerA, runId: string) => {
          const terminal = await fixture.append(donor, runId);
          if (!terminal.admission) {
            throw new Error("Native source admission unavailable");
          }
          expect(
            await recordConversationKnowledgeTurn({
              ...owner,
              ...terminal,
              privateAudience: { participant: person, admission: terminal.admission },
            }),
          ).toBe(true);
        };
        await record(donorA, ownerA, "subset-a-one");
        await record(donorB, ownerB, "subset-b-one");
        const target = await fixture.branch("subset-recipient"),
          owner = await fixture.claim(target);
        const audience: ConversationPrivateAudience = {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          channelId: "test",
          accountId: "default",
          nativeChannelId: "native-subset-recipient",
          participant: person,
          assertCurrent: owner.assertCurrent,
        };
        const params = {
          ...owner,
          signal,
          originalParticipant: person,
          destinationAudience: audience,
          expectedAudienceIdentity: conversationKnowledgeParticipantIdentity(person),
          getRuntimeConfig: () => fixture.cfg,
          sourceCache: cache,
          preparationOnly: true,
        };
        const stage = async () => {
          const prepared = await prepareReplyConversationKnowledge({
            ...params,
            sourceCache: stagingCache,
          });
          prepared?.release();
          return (await loadTranscriptEvents(fixture.root)).flatMap((raw) => {
            const reference = readConversationKnowledgeReceipt(asOptionalRecord(raw)?.details);
            if (!reference) {
              return [];
            }
            const packet = stagingCache.peek(conversationKnowledgeContributionId(reference), 0);
            if (!packet) {
              throw new Error("Native staged donor text unavailable");
            }
            return [{ reference, packet }];
          });
        };
        expect(await prepareRecipientConversationProjection(params, await stage())).toBe(true);
        const oldA = cache.preparedContributionGroup(donorA, cache.preparedRoot!);
        expect(oldA).toBeDefined();
        await record(donorB, ownerB, "subset-b-two");
        const tail = await stage();
        const groups = vi.spyOn(personalRead, "preparePersonalConversationContributionGroup");
        const context = vi.spyOn(transcriptContext, "readSessionTranscriptModelContextAsync");
        const contexts = vi.spyOn(transcriptContext, "readSessionTranscriptModelContextsAsync");
        probes.push(groups, context, contexts);
        const started = performance.now();
        expect(await prepareRecipientConversationProjection(params, tail)).toBe(true);
        expect(groups).toHaveBeenCalledOnce();
        expect(groups.mock.calls[0]![0].sources).toEqual([
          expect.objectContaining({ sessionKey: donorB.sessionKey }),
        ]);
        expect(cache.preparedContributionGroup(donorA, cache.preparedRoot!)).toBe(oldA);
        expect(context).not.toHaveBeenCalled();
        expect(contexts).not.toHaveBeenCalled();
        const reusedMs = performance.now() - started;
        const third = await fixture.branch("subset-third"),
          thirdOwner = await fixture.claim(third);
        groups.mockClear();
        expect(
          await prepareRecipientConversationProjection(
            {
              ...params,
              ...thirdOwner,
              sourceCache: otherCache,
              destinationAudience: {
                ...audience,
                sessionKey: third.sessionKey,
                assertCurrent: thirdOwner.assertCurrent,
              },
            },
            tail,
          ),
        ).toBe(true);
        expect(groups).toHaveBeenCalledTimes(2);
        expect(context).not.toHaveBeenCalled();
        expect(contexts).not.toHaveBeenCalled();
        expect(otherCache.preparedContributionGroup(donorA, otherCache.preparedRoot!)).not.toBe(
          oldA,
        );
        console.info(
          JSON.stringify({
            scenario: "native-donor-subset-reuse",
            donorSources: 2,
            originalRanges: tail.length,
            changedDonorGroups: 1,
            independentThirdRecipientGroups: 2,
            sourceTextReadsDuringRebind: 0,
            reusedMs: Math.round(reusedMs),
          }),
        );
      } finally {
        for (const probe of probes.toReversed()) {
          probe.mockRestore();
        }
        try {
          cache.clear();
          otherCache.clear();
          stagingCache.clear();
        } finally {
          await fixture.close();
        }
      }
    },
  );
});
