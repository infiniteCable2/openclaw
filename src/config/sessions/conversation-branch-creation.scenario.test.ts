import { expect, it } from "vitest";
import { prepareConversationKnowledgeInitialContext } from "../../auto-reply/reply/conversation-knowledge-initial-context.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../../auto-reply/reply/session.js";
import {
  bindConversationPrivateAudience,
  type ConversationPrivateAudience,
} from "../../sessions/conversation-private-audience.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { readConversationKnowledgeImportProgress } from "./conversation-knowledge-packets.js";
import { recordConversationKnowledgeTurn } from "./conversation-knowledge-store.js";
import { loadSessionEntry, loadTranscriptEvents } from "./session-accessor.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
  type PreparedReplySessionInitialContext,
} from "./session-accessor.reset.js";
import type { SessionEntryCreationOperation } from "./session-accessor.sqlite-entry-cache.types.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";

// Real native generation custody, personal source grants and lifecycle/transcript workers.
// Controlled original transcript commits replace generation, not storage or admission.
it("adopts both original and projected-context generation claims on the same native creation", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "native-branch-creation" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      let generation: Awaited<ReturnType<typeof prepareSessionGenerationFacts>> | undefined;
      try {
        const cfg: OpenClawConfig = {
          agents: { entries: { main: { conversationMode: "branches" } } },
        };
        const donor = await fixture.branch("creation-donor");
        const owner = await fixture.claim(donor);
        const terminal = await fixture.append(donor, "native-initial-fact");
        expect(
          await recordConversationKnowledgeTurn({
            ...owner,
            ...terminal,
            privateAudience: { participant: person, admission: terminal.admission! },
          }),
        ).toBe(true);
        const target = {
          ...donor,
          sessionKey: "agent:main:creation-recipient",
          sessionId: "creation-recipient",
          lifecycleRevision: "creation-recipient-life",
        };
        const snapshot = await loadReplySessionInitializationSnapshot(target);
        generation = await prepareSessionGenerationFacts({
          ...target,
          sessionId: null,
          lifecycleRevision: null,
        });
        const original = generation;
        const audience: ConversationPrivateAudience = {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          channelId: "matrix",
          accountId: "default",
          nativeChannelId: "private-example",
          participant: person,
          assertCurrent: original.assertCurrent,
        };
        let originalOperation: SessionEntryCreationOperation | undefined;
        let preparedOperation: SessionEntryCreationOperation | undefined;
        let finalPrepared: PreparedReplySessionInitialContext | undefined;
        let adoptedBeforeRelease = false;
        const result = await commitReplySessionInitialization({
          ...target,
          activeSessionKey: target.sessionKey,
          expectedRevision: snapshot.revision,
          branchRootSessionKey: fixture.root.sessionKey,
          sessionEntry: {
            sessionId: target.sessionId,
            lifecycleRevision: target.lifecycleRevision,
            updatedAt: Date.now(),
            visibility: "draft",
            chatType: "direct",
          },
          commitGuard: original.assertCurrent,
          bindCreation(operation) {
            originalOperation = operation;
            return original.bindCreation(operation);
          },
          async prepareInitialContext(entry) {
            const prepared = await prepareConversationKnowledgeInitialContext({
              ...target,
              sessionEntry: entry,
              cfg,
              getRuntimeConfig: () => cfg,
              audience,
              assertCurrent: original.assertCurrent,
            });
            if (!prepared) {
              throw new Error("Expected the real root projection before native creation");
            }
            finalPrepared = prepared;
            return {
              ...prepared,
              bindCreation(operation) {
                preparedOperation = operation;
                return prepared.bindCreation(operation);
              },
              async release() {
                try {
                  adoptedBeforeRelease = original.isCreationAdopted();
                  original.assertCurrent();
                  prepared.source();
                } finally {
                  await prepared.release();
                }
              },
            };
          },
        });
        expect(result.ok).toBe(true);
        expect(finalPrepared).toBeDefined();
        expect(preparedOperation).toBe(originalOperation);
        expect(adoptedBeforeRelease).toBe(true);
        expect(original.isCreationAdopted()).toBe(true);
        expect(() => original.assertCurrent()).not.toThrow();
        const events = await loadTranscriptEvents(target);
        expect(JSON.stringify(events)).toContain("native-initial-fact answer");
        expect(result.ok && result.sessionEntry.forkSource).toBeUndefined();
        const topology = result.ok && result.sessionEntry.conversationTopology;
        if (!topology || topology.role !== "branch") {
          throw new Error("Expected native branch membership");
        }
        const progress = await readConversationKnowledgeImportProgress({
          branch: {
            ...target,
            root: {
              sessionKey: topology.rootSessionKey,
              sessionId: topology.rootSessionId,
              lifecycleRevision: topology.rootSessionLifecycleRevision,
            },
          },
          assertCurrent: original.assertCurrent,
        });
        expect(progress.packets.size).toBeGreaterThan(0);
        expect([...progress.packets.values()].every((packet) => packet.complete)).toBe(true);
        expect(progress.checkpoints).toHaveLength(0);
      } finally {
        generation?.release();
        await fixture.close();
      }
    },
  );
});

it("copies populated root knowledge through ordinary ingress before its first model input", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "native-branch-ingress" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      try {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: { workspace: state.workspaceDir },
            entries: { main: { conversationMode: "branches" } },
          },
          session: { store: fixture.root.storePath, dmScope: "per-channel-peer" },
        };
        await state.writeConfig(cfg);
        const donor = await fixture.branch("ingress-donor");
        const owner = await fixture.claim(donor);
        const terminal = await fixture.append(donor, "ingress-original-fact");
        expect(
          await recordConversationKnowledgeTurn({
            ...owner,
            ...terminal,
            privateAudience: { participant: person, admission: terminal.admission! },
          }),
        ).toBe(true);
        const originals = await loadTranscriptEvents(donor);
        const target = {
          agentId: fixture.root.agentId,
          storePath: fixture.root.storePath,
          env: state.env,
          sessionKey: "agent:main:matrix:direct:ingress-positive",
        };
        expect(loadSessionEntry(target)).toBeUndefined();
        const ctx = finalizeInboundContext({
          Body: "First actual ingress request.",
          RawBody: "First actual ingress request.",
          ChatType: "direct",
          SessionKey: target.sessionKey,
          Provider: "matrix",
          Surface: "matrix",
          From: `matrix:${person.id}`,
          To: "room:private-ingress",
          SenderId: person.id,
          SessionCreation: {
            via: "channel",
            actor: { type: "human", source: "channel", id: person.id },
          },
        });
        bindConversationPrivateAudience(ctx, {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          channelId: "matrix",
          accountId: "default",
          nativeChannelId: "private-ingress",
          participant: person,
          assertCurrent: owner.assertCurrent,
        });
        // This enters the real outer session writer; projection preparation must
        // not queue a nested writer against that same held initialization lane.
        const result = await initSessionState({
          cfg,
          ctx,
          commandAuthorized: true,
          assertSourceCurrent: owner.assertCurrent,
        });
        expect(result.isNewSession).toBe(true);
        expect(result.sessionKey).toBe(target.sessionKey);
        expect(result.sessionEntry).toMatchObject({
          visibility: "draft",
          createdActor: { type: "human", source: "channel", id: person.id },
          conversationTopology: { role: "branch" },
        });
        expect(result.sessionEntry.forkSource).toBeUndefined();
        expect(result.sessionEntry.parentSessionKey).toBeUndefined();
        expect(result.sessionEntry.spawnedBy).toBeUndefined();
        const initialized = { ...target, sessionId: result.sessionId };
        const events = await loadTranscriptEvents(initialized);
        expect(JSON.stringify(events)).toContain("ingress-original-fact answer");
        expect(JSON.stringify(events)).not.toContain("First actual ingress request.");
        const topology = result.sessionEntry.conversationTopology;
        if (topology?.role !== "branch" || !result.sessionEntry.lifecycleRevision) {
          throw new Error("Expected a fully initialized native ingress branch");
        }
        const progress = await readConversationKnowledgeImportProgress({
          branch: {
            ...initialized,
            lifecycleRevision: result.sessionEntry.lifecycleRevision,
            root: {
              sessionKey: topology.rootSessionKey,
              sessionId: topology.rootSessionId,
              lifecycleRevision: topology.rootSessionLifecycleRevision,
            },
          },
          assertCurrent: owner.assertCurrent,
        });
        expect(progress.packets.size).toBe(1);
        expect([...progress.packets.values()].every((packet) => packet.complete)).toBe(true);
        expect(await loadTranscriptEvents(donor)).toEqual(originals);
      } finally {
        await fixture.close();
      }
    },
  );
}, 30_000);
