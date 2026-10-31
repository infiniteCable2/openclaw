import { expect, it } from "vitest";
import { prepareConversationKnowledgeInitialContext } from "../../auto-reply/reply/conversation-knowledge-initial-context.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { readConversationKnowledgeImportProgress } from "./conversation-knowledge-packets.js";
import { recordConversationKnowledgeTurn } from "./conversation-knowledge-store.js";
import { loadTranscriptEvents } from "./session-accessor.js";
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
