import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import * as checkpointFrames from "../../auto-reply/reply/conversation-knowledge-checkpoint-frame-source.js";
import {
  acquirePreparedConversationKnowledgeInitialFrame,
  registerConversationKnowledgeCheckpointOwner,
} from "../../auto-reply/reply/conversation-knowledge-checkpoint-owner.js";
import * as checkpointSources from "../../auto-reply/reply/conversation-knowledge-checkpoint-source.js";
import { prepareConversationKnowledgeInitialContext } from "../../auto-reply/reply/conversation-knowledge-initial-context.js";
import {
  createConversationKnowledgeScenario,
  person,
} from "../../auto-reply/reply/conversation-knowledge.scenario.test-support.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../../auto-reply/reply/session.js";
import * as personalReads from "../../gateway/session-transcript-personal-read.js";
import {
  bindConversationPrivateAudience,
  type ConversationPrivateAudience,
} from "../../sessions/conversation-private-audience.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  CONVERSATION_KNOWLEDGE_CONTEXT,
  readConversationKnowledgeImportProgress,
} from "./conversation-knowledge-packets.js";
import { recordConversationKnowledgeTurn } from "./conversation-knowledge-store.js";
import { loadSessionEntry, loadTranscriptEvents } from "./session-accessor.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
  type PreparedReplySessionInitialContext,
} from "./session-accessor.reset.js";
import type { SessionEntryCreationOperation } from "./session-accessor.sqlite-entry-cache.types.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";
import * as frameBorrow from "./session-initial-context-frame.js";
import * as sourceContexts from "./session-transcript-context-read.js";

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

it("reuses an off-turn native root frame across fresh ingress branches without donor discovery", async ({
  signal,
}) => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "native-shared-initial-frame" },
    async (state) => {
      const fixture = await createConversationKnowledgeScenario(state);
      let registration: ReturnType<typeof registerConversationKnowledgeCheckpointOwner> | undefined;
      const heldFrames: NonNullable<
        ReturnType<typeof acquirePreparedConversationKnowledgeInitialFrame>
      >[] = [];
      const resumes: (() => void)[] = [];
      const spies: { mockRestore(): void }[] = [];
      const stages: string[] = [];
      try {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: { workspace: state.workspaceDir },
            entries: { main: { conversationMode: "branches" } },
          },
          session: { store: fixture.root.storePath, dmScope: "per-channel-peer" },
        };
        await state.writeConfig(cfg);
        const donorA = await fixture.branch("frame-donor-a");
        const donorB = await fixture.branch("frame-donor-b");
        const donors = [donorA, donorB] as const;
        const donorOwners = [await fixture.claim(donorA), await fixture.claim(donorB)] as const;
        const publish = async (runId: string, donorIndex: 0 | 1 = 0) => {
          const terminal = await fixture.append(donors[donorIndex], runId);
          expect(
            await recordConversationKnowledgeTurn({
              ...donorOwners[donorIndex],
              ...terminal,
              privateAudience: { participant: person, admission: terminal.admission! },
            }),
          ).toBe(true);
        };
        for (let index = 0; index < 3; index++) {
          await publish(`sealed-original-${index}`, index === 2 ? 1 : 0);
        }
        const broker = await fixture.branch("frame-broker");
        const brokerOwner = await fixture.claim(broker);
        const topology = loadSessionEntry(broker)?.conversationTopology;
        if (topology?.role !== "branch") {
          throw new Error("Expected the real private frame broker");
        }
        const branch = {
          ...broker,
          root: {
            sessionKey: topology.rootSessionKey,
            sessionId: topology.rootSessionId,
            lifecycleRevision: topology.rootSessionLifecycleRevision,
          },
        };
        let expectedOriginals = 3;
        let ready = createDeferredCore();
        let previousFrame:
          | NonNullable<
              ReturnType<typeof acquirePreparedConversationKnowledgeInitialFrame>
            >["frame"]
          | undefined;
        const prepareFrame = checkpointFrames.prepareCheckpointInitialFrame;
        const prepareSources = checkpointSources.prepareConversationKnowledgeCheckpointSources;
        const sourceAttempts = vi
          .spyOn(checkpointSources, "prepareConversationKnowledgeCheckpointSources")
          .mockImplementation((input) => {
            stages.push("prepare-sources");
            const result = prepareSources(input);
            void result.then(
              () => stages.push("sources-prepared"),
              (error: unknown) =>
                stages.push(
                  `sources-refused:${error instanceof Error ? error.message : "unknown"}`,
                ),
            );
            return result;
          });
        spies.push(sourceAttempts);
        spies.push(
          vi
            .spyOn(checkpointFrames, "prepareCheckpointInitialFrame")
            .mockImplementation((input) => {
              stages.push("prepare-frame");
              const result = prepareFrame(input);
              void result.then(
                (value) => stages.push(value ? "frame-prepared" : "frame-unavailable"),
                (error: unknown) =>
                  stages.push(
                    `frame-refused:${error instanceof Error ? error.message : "unknown"}`,
                  ),
              );
              return result;
            }),
        );
        const groups = vi.spyOn(personalReads, "preparePersonalConversationContributionGroup");
        spies.push(groups);
        stages.push("register-root");
        registration = registerConversationKnowledgeCheckpointOwner({
          branch,
          participant: person,
          env: state.env,
          getRuntimeConfig: () => cfg,
          audience: {
            agentId: broker.agentId,
            sessionKey: broker.sessionKey,
            channelId: "matrix",
            accountId: "default",
            nativeChannelId: "private-frame-broker",
            participant: person,
            assertCurrent: brokerOwner.assertCurrent,
          },
          onReady() {
            stages.push(`root-notified:${registration?.projection().tail.length ?? -1}`);
            try {
              if (!registration || registration.projection().tail.length !== expectedOriginals) {
                return;
              }
              const candidate = acquirePreparedConversationKnowledgeInitialFrame({
                branch,
                participant: person,
              });
              if (!candidate) {
                return;
              }
              if (candidate.frame === previousFrame) {
                void candidate.release().catch(ready.reject);
                return;
              }
              previousFrame = candidate.frame;
              heldFrames.push(candidate);
              // Publish the frame before optional summary/model work. Pausing only
              // the disposable quantum must leave its native source custody live.
              resumes.push(registration.pausePreparation());
              ready.resolve();
            } catch (error) {
              ready.reject(error);
            }
          },
        });
        await withinTest(ready.promise, signal);
        stages.push("initial-frame-ready");
        expect(groups).toHaveBeenCalledTimes(2);
        expect(
          groups.mock.calls
            .map(([input]) => input.sources[0]?.sessionKey)
            .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
        ).toEqual(
          [donorA.sessionKey, donorB.sessionKey].toSorted((left, right) =>
            left.localeCompare(right),
          ),
        );
        groups.mockClear();
        sourceAttempts.mockClear();
        const discovery = vi.spyOn(
          checkpointSources,
          "prepareConversationKnowledgeCheckpointSources",
        );
        const bodies = vi.spyOn(sourceContexts, "readSessionTranscriptModelContextAsync");
        const borrowing = vi.spyOn(frameBorrow, "borrowPreparedConversationKnowledgeInitialFrame");
        spies.push(discovery, bodies, borrowing);
        const create = async (suffix: string, count: number) => {
          stages.push(`create-${suffix}`);
          const target = {
            agentId: broker.agentId,
            storePath: broker.storePath,
            env: state.env,
            sessionKey: `agent:main:matrix:direct:sealed-${suffix}`,
          };
          expect(loadSessionEntry(target)).toBeUndefined();
          const ctx = finalizeInboundContext({
            Body: "First request after frame copy.",
            RawBody: "First request after frame copy.",
            ChatType: "direct",
            SessionKey: target.sessionKey,
            Provider: "matrix",
            Surface: "matrix",
            From: `matrix:${person.id}`,
            To: `room:sealed-${suffix}`,
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
            nativeChannelId: `sealed-${suffix}`,
            participant: person,
            assertCurrent: brokerOwner.assertCurrent,
          });
          const result = await withinTest(
            initSessionState({
              cfg,
              ctx,
              commandAuthorized: true,
              assertSourceCurrent: brokerOwner.assertCurrent,
              signal,
            }),
            signal,
          );
          stages.push(`created-${suffix}`);
          expect(result.sessionEntry.visibility).toBe("draft");
          expect(result.sessionEntry.forkSource).toBeUndefined();
          expect(result.sessionEntry.parentSessionKey).toBeUndefined();
          expect(result.sessionEntry.spawnedBy).toBeUndefined();
          const initialized = { ...target, sessionId: result.sessionId };
          const events = await loadTranscriptEvents(initialized);
          const content = JSON.stringify(events);
          for (let index = 0; index < Math.min(3, count); index++) {
            expect(content).toContain(`sealed-original-${index} answer`);
          }
          expect(content).not.toContain("First request after frame copy.");
          const progress = await readConversationKnowledgeImportProgress({
            branch: {
              ...initialized,
              lifecycleRevision: result.sessionEntry.lifecycleRevision!,
              root: branch.root,
            },
            assertCurrent: brokerOwner.assertCurrent,
          });
          expect(progress.packets.size).toBe(count);
          expect([...progress.packets.values()].every((packet) => packet.complete)).toBe(true);
          const packetIds = events.flatMap((event) => {
            const record = asOptionalRecord(event);
            const packetId = asOptionalRecord(record?.details)?.packetId;
            return record?.customType === CONVERSATION_KNOWLEDGE_CONTEXT &&
              typeof packetId === "string"
              ? [packetId]
              : [];
          });
          expect(packetIds).toHaveLength(count);
          expect(new Set(packetIds).size).toBe(count);
          return { initialized, packetIds: packetIds.toSorted() };
        };
        const first = await create("first", 3);
        const second = await create("second", 3);
        expect(second.packetIds).toEqual(first.packetIds);
        expect(borrowing).toHaveBeenCalledTimes(2);
        expect(discovery).not.toHaveBeenCalled();
        expect(groups).not.toHaveBeenCalled();
        expect(bodies).not.toHaveBeenCalled();

        // A new original alone wakes the root; no target turn builds the successor.
        expectedOriginals = 4;
        ready = createDeferredCore();
        await publish("sealed-later-delta");
        resumes.shift()!();
        await withinTest(ready.promise, signal);
        expect(groups).toHaveBeenCalledOnce();
        expect(groups.mock.calls[0]![0].sources[0]?.sessionKey).toBe(donorA.sessionKey);
        discovery.mockClear();
        groups.mockClear();
        bodies.mockClear();
        borrowing.mockClear();
        const third = await create("updated", 4);
        expect(third.packetIds.filter((id) => !first.packetIds.includes(id))).toHaveLength(1);
        expect(first.packetIds.every((id) => third.packetIds.includes(id))).toBe(true);
        expect(JSON.stringify(await loadTranscriptEvents(third.initialized))).toContain(
          "sealed-later-delta answer",
        );
        expect(borrowing).toHaveBeenCalledOnce();
        expect(discovery).not.toHaveBeenCalled();
        expect(groups).not.toHaveBeenCalled();
        expect(bodies).not.toHaveBeenCalled();
        expect((await fixture.receipts()).length).toBe(4);
      } finally {
        console.log(JSON.stringify({ scenario: "native-shared-initial-frame", stages }));
        for (const spy of spies.toReversed()) {
          spy.mockRestore();
        }
        for (const held of heldFrames.toReversed()) {
          await held.release();
        }
        await registration?.close();
        for (const resume of resumes) {
          resume();
        }
        await fixture.close();
      }
    },
  );
}, 30_000);
