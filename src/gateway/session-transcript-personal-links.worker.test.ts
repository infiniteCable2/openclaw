import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createConversationKnowledgeSourceCache } from "../auto-reply/reply/conversation-knowledge-source-cache.js";
import { prepareReplyConversationKnowledge } from "../auto-reply/reply/conversation-knowledge.js";
import { createConversationKnowledgeScenario } from "../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { conversationKnowledgeParticipantIdentity } from "../config/sessions/conversation-audience.js";
import {
  readConversationKnowledgeBranch,
  readConversationKnowledgeRoot,
  recordConversationKnowledgeTurn,
} from "../config/sessions/conversation-knowledge-store.js";
import { readConversationKnowledgeReceipt } from "../config/sessions/conversation-knowledge.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import { recordSessionParticipantInWorker } from "../config/sessions/session-sharing-store.async.js";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import type { ConversationPrivateAudience } from "../sessions/conversation-private-audience.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  PersonalConversationReadRefusedError,
  preparePersonalConversationContributionGroup,
  preparePersonalConversationRead,
} from "./session-transcript-personal-read.js";

// All profiles, identity links, saved ranges, root evidence and sharing facts
// use their actual native workers. The spy only observes real state reads.
it("qualifies saved legacy remote ranges through a native source-account link and revokes retained custody", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "personal-native-links" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        const profile = await ensureCanonicalUserProfileForEmail("reader@example.test", {
          env: state.env,
        });
        const recipient: SessionParticipantIdentity = { type: "profile", id: profile.id };
        const legacy: SessionParticipantIdentity = {
          type: "remote",
          pluginId: "matrix",
          domain: "matrix",
          idKind: "user-id",
          id: "@reader:example.test",
        };
        const identity = {
          channelId: "matrix",
          accountId: "source-account",
          senderId: legacy.id,
        };
        const source = await fixture.branch("legacy-remote", legacy);
        await upsertSessionEntryCore(source, {
          createdActor: { type: "human", source: "channel", id: legacy.id },
          delivery: {
            kind: "external",
            route: { channel: "matrix", accountId: identity.accountId },
            context: {},
            origin: { from: legacy.id },
          },
        });
        const destination = await fixture.branch("linked-profile", recipient);
        await upsertSessionEntryCore(destination, {
          createdActor: { type: "human", source: "profile", id: profile.id },
        });
        const sourceOwner = await fixture.claim(source);
        const destinationOwner = await fixture.claim(destination);
        for (let index = 0; index < 3; index++) {
          const turn = await fixture.append(source, `saved-${index}`);
          if (!turn.admission) {
            throw new Error("Native saved turn has no committed admission anchor");
          }
          expect(
            await recordConversationKnowledgeTurn({
              ...sourceOwner,
              ...turn,
              privateAudience: { participant: legacy, admission: turn.admission },
            }),
          ).toBe(true);
        }
        const target = await readConversationKnowledgeBranch(destinationOwner);
        if (!target) {
          throw new Error("Native profile recipient branch is missing");
        }
        const events = await readConversationKnowledgeRoot({ ...destinationOwner, branch: target });
        if (!events.evidence) {
          throw new Error("Saved ranges require the actual branded native root evidence");
        }
        const contributions = events.flatMap((event) => {
          const receipt = readConversationKnowledgeReceipt(asOptionalRecord(event)?.details);
          return receipt ? [receipt] : [];
        });
        expect(contributions).toHaveLength(3);
        expect(contributions.map((item) => item.privateAudience?.participant)).toEqual([
          legacy,
          legacy,
          legacy,
        ]);
        const savedReferences = structuredClone(contributions);
        const request = {
          purpose: "conversation-differences" as const,
          getRuntimeConfig: () => fixture.cfg,
          sources: [{ agentId: source.agentId, sessionKey: source.sessionKey }],
          personal: {
            originalParticipant: recipient,
            assertCurrent: destinationOwner.assertCurrent,
            target,
            rootEvidence: events.evidence,
            contributions,
          },
        };
        // The same native MXID linked on another account is not source authority.
        await changeCanonicalUserChannelIdentity("link", profile.id, {
          ...identity,
          accountId: "other-account",
        });
        await expect(preparePersonalConversationContributionGroup(request)).rejects.toThrow(
          "same-person source custody",
        );
        await changeCanonicalUserChannelIdentity("link", profile.id, identity);
        const cache = createConversationKnowledgeSourceCache();
        const projectPackets = async () => {
          const params = {
            ...destinationOwner,
            originalParticipant: recipient,
            getRuntimeConfig: () => fixture.cfg,
            sourceCache: cache,
          };
          const ahead = await prepareReplyConversationKnowledge({
            ...params,
            preparationOnly: true,
          });
          if (!ahead) {
            throw new Error("Native preparation did not retain the related source");
          }
          ahead.release();
          expect(cache.preparedRoot).toBeDefined();
          const ready = await prepareReplyConversationKnowledge({ ...params, readyOnly: true });
          if (!ready) {
            throw new Error("Native prepared related-history packets are missing");
          }
          try {
            ready.assertCurrent();
            return ready.fragments.map((fragment) => fragment.text).join("\n");
          } finally {
            ready.release();
          }
        };
        try {
          const first = await projectPackets();
          for (let index = 0; index < 3; index++) {
            expect(first).toContain(`saved-${index} answer`);
          }
          const adjacent = await fixture.append(source, "saved-adjacent");
          if (!adjacent.admission) {
            throw new Error("Adjacent native turn has no committed anchor");
          }
          expect(
            await recordConversationKnowledgeTurn({
              ...sourceOwner,
              ...adjacent,
              privateAudience: { participant: legacy, admission: adjacent.admission },
            }),
          ).toBe(true);
          expect(await projectPackets()).toContain("saved-adjacent answer");
        } finally {
          cache.clear();
        }
        const allSavedReferences = await fixture.receipts();
        expect(allSavedReferences.slice(0, 3)).toEqual(savedReferences);
        const adjacentReference = allSavedReferences.find(
          (reference) => reference.runId === "saved-adjacent",
        );
        if (!adjacentReference) {
          throw new Error("Adjacent native root receipt is missing");
        }
        const observeReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
        const identityReads = () =>
          observeReads.mock.calls.filter(
            ([, read]) => read.type === "userProfiles.channelIdentity.resolve",
          );
        try {
          const group = await preparePersonalConversationContributionGroup(request);
          try {
            const readRequest = {
              ...request,
              personal: { ...request.personal, contributionGroup: group },
            };
            const grant = await preparePersonalConversationRead(readRequest);
            try {
              expect(grant.audienceIdentity).toBe(
                conversationKnowledgeParticipantIdentity(recipient),
              );
              expect(grant.sources).toMatchObject([
                { canonicalKey: source.sessionKey, sessionId: source.sessionId },
              ]);
              for (const contribution of contributions) {
                expect(grant.selectContribution(contribution)).toBeDefined();
                grant.assertCurrent();
              }
              expect(grant.selectContribution(adjacentReference)).toBeUndefined();
              const rebound = await preparePersonalConversationRead(readRequest);
              try {
                rebound.assertCurrent();
              } finally {
                rebound.release();
              }
              const prepared = await prepareSessionSourceAuthority(grant.assertCurrent);
              try {
                expect(identityReads()).toHaveLength(1);
                expect(identityReads()[0]?.[1]).toMatchObject({
                  identity,
                });
                await changeCanonicalUserChannelIdentity("unlink", profile.id, identity);
                expect(() => prepared.assertPreparedCurrent?.()).toThrow("identity link changed");
                expect(() => grant.assertCurrent()).toThrow(PersonalConversationReadRefusedError);
                await expect(preparePersonalConversationRead(readRequest)).rejects.toThrow(
                  "identity link changed",
                );
                expect(identityReads()).toHaveLength(1);
              } finally {
                await prepared.release?.();
              }
            } finally {
              grant.release();
            }
          } finally {
            group.release();
          }
        } finally {
          observeReads.mockRestore();
        }
        await expect(preparePersonalConversationContributionGroup(request)).rejects.toThrow(
          PersonalConversationReadRefusedError,
        );
        // Linking never rewrites or promotes the immutable remote audience/ranges.
        expect(await fixture.receipts()).toEqual(allSavedReferences);
      } finally {
        await fixture.close();
      }
    },
  );
});

it("admits profile Echo ranges into a currently private profile recipient with a legacy Matrix roster", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "personal-native-reverse" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      const cache = createConversationKnowledgeSourceCache();
      try {
        const profile = await ensureCanonicalUserProfileForEmail("reader@example.test", {
          env: state.env,
        });
        const person: SessionParticipantIdentity = { type: "profile", id: profile.id };
        const legacy: SessionParticipantIdentity = {
          type: "remote",
          pluginId: "matrix",
          domain: "matrix",
          idKind: "user-id",
          id: "@reader:example.test",
        };
        const identity = {
          channelId: "matrix",
          accountId: "recipient-account",
          senderId: legacy.id,
        };
        await changeCanonicalUserChannelIdentity("link", profile.id, identity);
        const destination = await fixture.branch("legacy-matrix-recipient", legacy, "channel");
        await upsertSessionEntryCore(destination, {
          createdActor: { type: "human", source: "channel", id: legacy.id },
          delivery: {
            kind: "external",
            route: { channel: "matrix", accountId: identity.accountId },
            context: {},
            origin: { from: legacy.id },
          },
        });
        for (const participant of [
          {
            type: "observation",
            pluginId: "matrix",
            accountId: identity.accountId,
            senderKind: "human",
            id: legacy.id,
          } satisfies SessionParticipantIdentity,
          person,
        ]) {
          expect(
            await recordSessionParticipantInWorker(destination, {
              identity: participant,
              promptedAt: Date.now(),
              sessionAgentId: destination.agentId,
              expectedSession: destination,
            }),
          ).toBe("inserted");
        }
        const source = await fixture.branch("profile-echo-source", person);
        await upsertSessionEntryCore(source, {
          createdActor: { type: "human", source: "profile", id: profile.id },
        });
        const sourceOwner = await fixture.claim(source);
        const destinationOwner = await fixture.claim(destination);
        const turn = await fixture.append(source, "reverse-profile-echo");
        if (!turn.admission) {
          throw new Error("Native source input has no exact admission anchor");
        }
        expect(
          await recordConversationKnowledgeTurn({
            ...sourceOwner,
            ...turn,
            privateAudience: { participant: person, admission: turn.admission },
          }),
        ).toBe(true);
        const roster = structuredClone(loadSessionEntry(destination)?.participants);
        expect(roster?.map((row) => row.identity.type).toSorted()).toEqual([
          "observation",
          "profile",
          "remote",
        ]);
        // Only the host's current private ingress proves disclosure to this
        // existing channel. A historical mixed roster cannot supply that proof.
        const audience: ConversationPrivateAudience = {
          agentId: destination.agentId,
          sessionKey: destination.sessionKey,
          channelId: "matrix",
          accountId: identity.accountId,
          nativeChannelId: "synthetic-private-matrix-room",
          participant: person,
          assertCurrent: destinationOwner.assertCurrent,
        };
        const params = {
          ...destinationOwner,
          originalParticipant: person,
          destinationAudience: audience,
          getRuntimeConfig: () => fixture.cfg,
          sourceCache: cache,
        };
        const prepared = await prepareReplyConversationKnowledge({
          ...params,
          preparationOnly: true,
        });
        prepared?.release();
        expect(cache.preparedRoot).toBeDefined();
        const ready = await prepareReplyConversationKnowledge({ ...params, readyOnly: true });
        if (!ready) {
          throw new Error("Native reverse profile source was not prepared");
        }
        try {
          ready.assertCurrent();
          expect(ready.fragments.map((fragment) => fragment.text).join("\n")).toContain(
            "reverse-profile-echo answer",
          );
          expect(loadSessionEntry(destination)?.participants).toEqual(roster);
          destinationOwner.revoke();
          expect(() => ready.assertCurrent()).toThrow();
        } finally {
          ready.release();
        }
      } finally {
        cache.clear();
        await fixture.close();
      }
    },
  );
});
