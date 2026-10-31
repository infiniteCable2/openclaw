import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { conversationKnowledgeParticipantIdentity } from "./conversation-audience.js";
import { createConversationKnowledgeCheckpoint } from "./conversation-knowledge-checkpoint.js";
import { readConversationKnowledgeImportProgress } from "./conversation-knowledge-packets.js";
import {
  conversationKnowledgeOrigin,
  projectConversationKnowledge,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
  replaceTranscriptEvents,
} from "./session-accessor.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "./session-accessor.reset.js";
import {
  buildForkedChildTranscriptEvents,
  resolveParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import {
  createProjectedInitialSessionContextEvents,
  type PreparedInitialSessionContext,
  type PreparedProjectedInitialSessionContext,
} from "./session-initial-context.js";
import { composeSessionSourceAssertion } from "./session-source-authority.js";
import type {
  PreparedSessionSourceAuthority,
  SessionSourceAssertion,
} from "./session-source-authority.js";
import { readSessionTranscriptAnchorsAsync } from "./session-transcript-anchor-read.js";
import {
  readPreparedSessionTranscriptChange,
  type SessionTranscriptAuthority,
} from "./session-transcript-authority.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import type { InternalSessionEntry } from "./types.js";

let state: OpenClawTestState;
let nextId = 0;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "initial-context" });
});
afterAll(async () => {
  await state.cleanup();
});

function observeCreation(sessionKey: string) {
  const rowIds: Array<string | null> = [];
  const transcripts: SessionTranscriptAuthority[] = [];
  const stop = sessionChanges.subscribeFacts((change) => {
    if (!("sessionKey" in change) || change.sessionKey !== sessionKey) {
      return;
    }
    if (change.facts?.kind === "entry") {
      rowIds.push(change.facts.sessionId);
    } else if (change.facts?.kind === "replacement") {
      rowIds.push(change.facts.membership[4]);
    }
    const transcript = readPreparedSessionTranscriptChange(change);
    if (transcript?.kind === "postimage") {
      transcripts.push(transcript.value);
    }
  });
  return { rowIds, transcripts, stop };
}

async function withContext(
  run: (fixture: {
    source: { agentId: string; sessionKey: string; storePath: string; sessionId: string };
    target: { agentId: string; sessionKey: string; storePath: string; sessionId: string };
    context: PreparedInitialSessionContext;
    authority: SessionSourceAssertion;
    commit: (
      overrides?: Partial<Parameters<typeof commitReplySessionInitialization>[0]>,
    ) => ReturnType<typeof commitReplySessionInitialization>;
  }) => Promise<void>,
  options?: { root?: boolean },
) {
  const id = ++nextId;
  const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
  const source = {
    agentId: "main",
    storePath,
    sessionKey: `agent:main:source-${id}`,
    sessionId: `source-${id}`,
  };
  const target = {
    ...source,
    sessionKey: `agent:main:matrix:group:room-${id}`,
    sessionId: `target-${id}`,
  };
  await upsertSessionEntryCore(source, {
    sessionId: source.sessionId,
    updatedAt: 1,
    lifecycleRevision: "original",
    createdActor: { type: "human", source: "profile", id: "source-owner" },
    permissionMode: "full",
    ...(options?.root
      ? {
          createdVia: "internal" as const,
          createdActor: { type: "system" as const, id: "conversation-root" },
          visibility: "draft" as const,
          delivery: { kind: "none" as const },
          conversationTopology: { version: 1 as const, role: "root" as const },
        }
      : {}),
  });
  await appendTranscriptMessage(source, {
    eventId: `answer-${id}`,
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: `Completed context ${id}` }],
    },
  });
  const snapshot = await loadReplySessionInitializationSnapshot(target);
  await withSessionEntryReadOnlyInWorker(
    source,
    () => {},
    async (read, owner) => {
      if (!read.ok) {
        throw read.error;
      }
      if (!read.value || !owner.source || typeof owner.source.databaseIdentity !== "string") {
        throw new Error("Synthetic source was not admitted");
      }
      const hydration = await prepareSessionTranscriptHydration(source).read();
      if (hydration.kind !== "full") {
        throw new Error("Synthetic source requires its full transcript");
      }
      const selected = resolveParentForkSourceTranscript(
        hydration.snapshot.events,
        "last-completed",
      );
      if (!selected) {
        throw new Error("Synthetic completed context is unavailable");
      }
      const sourceThrough = (
        await readSessionTranscriptAnchorsAsync(source, { entryIds: [`answer-${id}`] })
      ).anchors[0];
      if (!sourceThrough) {
        throw new Error("Synthetic completed source anchor is unavailable");
      }
      const context: PreparedInitialSessionContext = {
        source: { ...owner.source, databaseIdentity: owner.source.databaseIdentity },
        sourceSessionKey: source.sessionKey,
        sourceEntry: {
          sessionId: read.value.sessionId,
          lifecycleRevision: read.value.lifecycleRevision,
        },
        sourceVersion: hydration.snapshot.version,
        sourceThrough,
        targetSessionId: target.sessionId,
        events: buildForkedChildTranscriptEvents({
          parentSessionFile: source.sessionKey,
          source: selected,
          targetSessionId: target.sessionId,
        }),
      };
      // This storage fixture owns a synthetic read witness. Gateway tests separately
      // exercise the real operator/profile read grant through this same writer.
      const contextSourceAuthority: SessionSourceAssertion = Object.assign(
        () => owner.assertCurrent(),
        {
          prepareSessionSource: async (): Promise<PreparedSessionSourceAuthority> => ({
            assertCurrent: owner.assertCurrent,
            checks: [
              {
                predicate: {
                  source: context.source,
                  sessionKey: source.sessionKey,
                  fields: [
                    "sessionId",
                    "lifecycleRevision",
                    "createdActor",
                    "visibility",
                    "incognito",
                  ],
                  expected: read.value,
                  members: [],
                },
                refuse: (): never => {
                  throw new Error("Synthetic source read witness changed");
                },
              },
            ],
          }),
        },
      );
      await run({
        source,
        target,
        context,
        authority: contextSourceAuthority,
        commit: (overrides) =>
          commitReplySessionInitialization({
            ...target,
            activeSessionKey: target.sessionKey,
            expectedRevision: snapshot.revision,
            commitGuard: owner.assertCurrent,
            contextSourceAuthority,
            initialContext: context,
            sessionEntry: {
              sessionId: target.sessionId,
              updatedAt: 2,
              chatType: "group",
              createdActor: { type: "human", source: "channel", id: "target-caller" },
              sandbox: "required",
              permissionMode: "workspace",
              totalTokens: 0,
              totalTokensFresh: true,
              cliSessionBindings: {
                "synthetic-cli": { sessionId: "wider-history", resumeCheckpointId: "checkpoint" },
              },
              cliSessionIds: { "synthetic-cli": "legacy-history" },
              claudeCliSessionId: "legacy-history",
              delivery: normalizeSessionDeliveryState({
                context: { channel: "matrix", to: "room:synthetic" },
              }),
            },
            ...overrides,
          }),
      });
    },
  );
}

async function withProjectedContext(
  run: (
    fixture: Omit<Parameters<Parameters<typeof withContext>[0]>[0], "context"> & {
      context: PreparedProjectedInitialSessionContext;
      donor: Parameters<Parameters<typeof withContext>[0]>[0]["source"];
    },
  ) => Promise<void>,
) {
  await withContext(
    async (fixture) => {
      const { source, target } = fixture;
      const donor = {
        ...source,
        sessionKey: `${source.sessionKey}-donor`,
        sessionId: `${source.sessionId}-donor`,
      };
      await upsertSessionEntryCore(donor, {
        sessionId: donor.sessionId,
        lifecycleRevision: "donor-original",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "source-owner" },
        visibility: "draft",
      });
      const originals = [];
      for (const text of ["A summarized earlier fact.", "A later original fact."]) {
        const original = await appendTranscriptMessage(donor, {
          message: { role: "user", content: text },
        });
        if (!original.anchor) {
          throw new Error("Synthetic original requires its actual native anchor");
        }
        originals.push(original.anchor);
      }
      await withSessionEntryReadOnlyInWorker(
        donor,
        () => {},
        async (read, owner) => {
          if (!read.ok || !read.value || !owner.source?.databaseIdentity) {
            throw new Error("Synthetic projected donor was not admitted");
          }
          const predicate = {
            source: owner.source,
            sessionKey: donor.sessionKey,
            fields: [
              "sessionId",
              "lifecycleRevision",
              "createdActor",
              "visibility",
              "incognito",
            ] as const,
            expected: read.value,
            members: [],
          };
          const donorAuthority: SessionSourceAssertion = Object.assign(
            () => owner.assertCurrent(),
            {
              prepareSessionSource: async (): Promise<PreparedSessionSourceAuthority> => ({
                assertCurrent: owner.assertCurrent,
                checks: [
                  {
                    predicate: { ...predicate, fields: [...predicate.fields] },
                    refuse: (): never => {
                      throw new Error("Synthetic projected donor changed");
                    },
                  },
                ],
              }),
            },
          );
          const authority = composeSessionSourceAssertion([fixture.authority, donorAuthority]);
          const participant = { type: "profile", id: "source-owner" } as const;
          const branch = {
            ...target,
            lifecycleRevision: "target-original",
            root: {
              sessionKey: source.sessionKey,
              sessionId: source.sessionId,
              lifecycleRevision: "original",
            },
          };
          const references: ConversationKnowledgeReference[] = originals.map((through) => ({
            version: 1,
            kind: "utterance-observation",
            sourceMode: "branches",
            role: "user",
            source: { ...donor, lifecycleRevision: "donor-original" },
            origin: conversationKnowledgeOrigin(
              { ...donor, lifecycleRevision: "donor-original" },
              "utterance-observation",
            ),
            through,
            privateAudience: { participant, admission: through },
          }));
          const checkpoint = createConversationKnowledgeCheckpoint({
            branch,
            audienceKey: conversationKnowledgeParticipantIdentity(participant)!,
            summary: "A native checkpoint summary of the earlier fact.",
            covered: [references[0]!],
          });
          await appendTranscriptEvent(source, {
            type: "custom_message",
            id: `${source.sessionId}-checkpoint`,
            customType: "openclaw.conversation-knowledge-checkpoint.v1",
            details: checkpoint,
            display: false,
          });
          const rootFacts = await readSessionTranscriptAnchorsAsync(source, {
            entryIds: [],
            includeContextVersion: true,
          });
          const donorFacts = await readSessionTranscriptAnchorsAsync(donor, {
            entryIds: [],
            includeContextVersion: true,
          });
          if (!rootFacts.contextVersion || !donorFacts.contextVersion) {
            throw new Error("Synthetic projection requires exact native source versions");
          }
          const part = projectConversationKnowledge(
            references[1]!,
            await loadTranscriptEvents(donor),
            undefined,
            "private-direct",
          );
          if (!part?.complete) {
            throw new Error("Synthetic packet requires its actual native source projection");
          }
          const projection: PreparedProjectedInitialSessionContext["projection"] = {
            branch,
            checkpoint,
            claims: originals.map((through, index) => ({
              reference: references[index]!,
              predicate: { ...predicate, fields: [...predicate.fields] },
              sessionId: donor.sessionId,
              version: donorFacts.contextVersion!,
              through,
              from: through,
            })),
            packets: [
              {
                receipt: references[1]!,
                text: part.text,
                offset: 0,
                nextOffset: part.nextOffset ?? 0,
                complete: part.complete,
                sourceClaim: 1,
              },
            ],
          };
          const context: PreparedProjectedInitialSessionContext = {
            ...fixture.context,
            kind: "root-projection",
            projection,
            sourceVersion: rootFacts.contextVersion,
            sourceThrough: undefined,
            events: createProjectedInitialSessionContextEvents({
              projection,
              targetSessionId: target.sessionId,
            }),
          };
          await run({
            ...fixture,
            donor,
            context,
            authority,
            commit: (overrides) =>
              fixture.commit({
                initialContext: context,
                contextSourceAuthority: authority,
                branchRootSessionKey: source.sessionKey,
                sessionEntry: {
                  sessionId: target.sessionId,
                  lifecycleRevision: branch.lifecycleRevision,
                  updatedAt: 2,
                  visibility: "draft",
                },
                ...overrides,
              }),
          });
        },
      );
    },
    { root: true },
  );
}

describe("native reply initial context", () => {
  it("atomically creates a branch with canonical checkpoint and packet progress", async () => {
    await withProjectedContext(async ({ target, donor, context, commit }) => {
      const originals = await loadTranscriptEvents(donor);
      const publication = observeCreation(target.sessionKey);
      try {
        expect((await commit()).ok).toBe(true);
      } finally {
        publication.stop();
      }
      const events = await loadTranscriptEvents(target);
      expect(events).toEqual(context.events);
      expect(events).toHaveLength(3);
      expect(loadSessionEntry(target)?.forkSource).toBeUndefined();
      const progress = await readConversationKnowledgeImportProgress({
        branch: context.projection.branch,
        assertCurrent() {},
      });
      expect(progress.packets.size).toBe(1);
      expect([...progress.packets.values()]).toEqual([{ complete: true, nextOffset: 0 }]);
      expect(progress.checkpoints.map((value) => value.checkpointId)).toEqual([
        context.projection.checkpoint!.checkpointId,
      ]);
      const final = await readSessionTranscriptAnchorsAsync(target, {
        entryIds: [],
        includeContextVersion: true,
      });
      expect(publication.rowIds).toContain(target.sessionId);
      expect(publication.transcripts.length).toBeGreaterThan(0);
      expect(
        publication.transcripts.every((value) => value.rawSeq === final.contextVersion?.rawSeq),
      ).toBe(true);
      expect(await loadTranscriptEvents(donor)).toEqual(originals);
    });
  });

  it.each([
    "donor-reset",
    "root-reset",
    "donor-model-lock",
    "permission",
    "late-permission",
    "target-visibility",
    "target-share",
    "target-parent",
    "target-spawn",
    "target-incognito",
    "missing-predicate",
  ] as const)(
    "refuses an initial root projection after %s without partial creation",
    async (change) => {
      await withProjectedContext(async ({ source, donor, target, context, commit }) => {
        const overrides: Partial<Parameters<typeof commitReplySessionInitialization>[0]> = {};
        if (change === "donor-reset" || change === "root-reset") {
          const selected = change === "donor-reset" ? donor : source;
          await replaceTranscriptEvents(selected, [
            { type: "session", id: selected.sessionId, version: 3 },
          ]);
        } else if (change === "donor-model-lock") {
          await upsertSessionEntryCore(donor, {
            ...loadSessionEntry(donor)!,
            modelSelectionLocked: true,
          });
        } else if (change === "permission") {
          await upsertSessionEntryCore(donor, {
            ...loadSessionEntry(donor)!,
            visibility: "shared",
          });
        } else if (change === "late-permission") {
          overrides.beforeEntryMutation = async () => {
            await upsertSessionEntryCore(donor, {
              ...loadSessionEntry(donor)!,
              visibility: "shared",
            });
          };
        } else if (change.startsWith("target-")) {
          const mutation: Partial<InternalSessionEntry> =
            change === "target-visibility"
              ? { visibility: "shared" }
              : change === "target-share"
                ? {
                    publicShare: {
                      id: "synthetic-share",
                      sessionId: target.sessionId,
                      createdAt: 1,
                    },
                  }
                : change === "target-parent"
                  ? { parentSessionKey: "agent:main:synthetic-parent" }
                  : change === "target-spawn"
                    ? { spawnedBy: "agent:main:synthetic-task" }
                    : { incognito: true };
          overrides.prepareSessionEntry = ({ sessionEntry }) =>
            Object.assign(sessionEntry, mutation);
        } else {
          overrides.initialContext = {
            ...context,
            projection: {
              ...context.projection,
              claims: context.projection.claims.map((claim) => ({
                ...claim,
                predicate: { ...claim.predicate, members: ["ungranted-synthetic-member"] },
              })),
            },
          };
        }
        await expect(commit(overrides)).rejects.toThrow();
        expect(loadSessionEntry(target)).toBeUndefined();
        expect(await loadTranscriptEvents(target)).toEqual([]);
      });
    },
  );

  it("copies only the prepared root prefix while a later root append remains a delta", async () => {
    await withProjectedContext(async ({ source, target, context, commit }) => {
      expect(
        (
          await commit({
            beforeEntryMutation: async () => {
              await appendTranscriptMessage(source, {
                message: { role: "user", content: "A later root suffix." },
              });
            },
          })
        ).ok,
      ).toBe(true);
      expect(await loadTranscriptEvents(target)).toEqual(context.events);
      expect(JSON.stringify(await loadTranscriptEvents(target))).not.toContain(
        "A later root suffix.",
      );
    });
  });

  it("does not reuse a hidden transcript identity for an initial root projection", async () => {
    await withProjectedContext(async ({ target, commit }) => {
      await appendTranscriptEvent(target, { type: "session", id: target.sessionId, version: 3 });
      const before = await loadTranscriptEvents(target);
      await expect(commit()).rejects.toThrow("unused target transcript");
      expect(loadSessionEntry(target)).toBeUndefined();
      expect(await loadTranscriptEvents(target)).toEqual(before);
    });
  });

  it("keeps original receipt identity separate from a granted current source range", async () => {
    await withProjectedContext(async ({ donor, target, context, commit }) => {
      const packet = context.projection.packets[0]!;
      // This storage witness owns the actual current row predicate. Native personal
      // read tests separately prove who may issue a historical-custody translation.
      await replaceTranscriptEvents(donor, [{ type: "session", id: donor.sessionId, version: 3 }]);
      const current = await appendTranscriptMessage(donor, {
        message: { role: "user", content: "A later original fact." },
      });
      const facts = await readSessionTranscriptAnchorsAsync(donor, {
        entryIds: [],
        includeContextVersion: true,
      });
      if (!current.anchor || !facts.contextVersion) {
        throw new Error("Synthetic current range was not admitted");
      }
      const projection: PreparedProjectedInitialSessionContext["projection"] = {
        branch: context.projection.branch,
        packets: [{ ...packet, sourceClaim: 0 }],
        claims: [
          {
            ...context.projection.claims[packet.sourceClaim]!,
            version: facts.contextVersion,
            from: current.anchor,
            through: current.anchor,
          },
        ],
      };
      expect(
        (
          await commit({
            initialContext: {
              ...context,
              projection,
              events: createProjectedInitialSessionContextEvents({
                projection,
                targetSessionId: target.sessionId,
              }),
            },
          })
        ).ok,
      ).toBe(true);
      const progress = await readConversationKnowledgeImportProgress({
        branch: projection.branch,
        assertCurrent() {},
      });
      expect(progress.packets.size).toBe(1);
      expect(current.anchor.generation).not.toBe(packet.receipt.through.generation);
    });
  });

  it.each(["created", "refused", "stale"] as const)(
    "retains and releases asynchronous native initial-context preparation when %s",
    async (outcome) => {
      await withProjectedContext(async ({ source, target, context, authority, commit }) => {
        let calls = 0,
          bound = 0,
          released = 0,
          asserted = 0;
        const result = commit({
          initialContext: undefined,
          contextSourceAuthority: undefined,
          prepareSessionEntry: ({ sessionEntry }) => ({
            ...sessionEntry,
            label: "final-native-row",
          }),
          prepareInitialContext: async (entry) => {
            calls++;
            expect(entry.label).toBe("final-native-row");
            expect(entry.conversationTopology).toMatchObject({
              role: "branch",
              rootSessionKey: source.sessionKey,
            });
            return {
              context,
              source: authority,
              assertEntry: (current) => {
                asserted++;
                expect(current.label).toBe("final-native-row");
                expect(current.conversationTopology).toEqual(entry.conversationTopology);
              },
              bindCreation: () => {
                bound++;
                return authority;
              },
              release: () => {
                released++;
              },
            };
          },
          beforeEntryMutation: async () => {
            if (outcome === "refused") {
              throw new Error("Synthetic prepared creation refusal");
            }
            if (outcome === "stale") {
              await upsertSessionEntryCore(target, { sessionId: "competing-target", updatedAt: 3 });
            }
          },
        });
        if (outcome === "refused") {
          await expect(result).rejects.toThrow("Synthetic prepared creation refusal");
          expect(loadSessionEntry(target)).toBeUndefined();
        } else {
          expect((await result).ok).toBe(outcome === "created");
        }
        expect(calls).toBe(1);
        expect(released).toBe(1);
        expect(asserted).toBe(outcome === "refused" ? 0 : 1);
        if (outcome === "created") {
          expect(bound).toBe(1);
          expect(await loadTranscriptEvents(target)).toEqual(context.events);
          const snapshot = await loadReplySessionInitializationSnapshot(target);
          expect(
            (
              await commit({
                initialContext: undefined,
                contextSourceAuthority: undefined,
                expectedRevision: snapshot.revision,
                sessionEntry: loadSessionEntry(target)!,
                prepareInitialContext: async () => {
                  calls++;
                  return undefined;
                },
              })
            ).ok,
          ).toBe(true);
          expect(calls).toBe(1);
        }
      });
    },
  );

  it.each(["unchanged", "archived", "published", "replaced"] as const)(
    "binds membership to the separately admitted root at the actual writer (%s)",
    async (change) => {
      await withContext(async ({ source, target, commit }) => {
        const root = {
          ...source,
          sessionKey: `agent:main:root-${++nextId}`,
          sessionId: `root-${nextId}`,
        };
        const entry: InternalSessionEntry = {
          sessionId: root.sessionId,
          lifecycleRevision: "root-first",
          updatedAt: 1,
          createdVia: "internal",
          createdActor: { type: "system", id: "conversation-root" },
          visibility: "draft",
          delivery: { kind: "none" },
          conversationTopology: { version: 1, role: "root" },
        };
        await upsertSessionEntryCore(root, entry);
        const operation = commit({
          branchRootSessionKey: root.sessionKey,
          beforeEntryMutation: async () => {
            if (change !== "unchanged") {
              await upsertSessionEntryCore(root, {
                ...entry,
                ...(change === "archived" ? { archivedAt: 2 } : {}),
                ...(change === "published" ? { visibility: "shared" as const } : {}),
                ...(change === "replaced" ? { lifecycleRevision: "root-replacement" } : {}),
              });
            }
          },
        });
        if (change === "unchanged") {
          await expect(operation).resolves.toMatchObject({ ok: true });
          expect(loadSessionEntry(target)).toMatchObject({
            conversationTopology: {
              version: 1,
              role: "branch",
              rootSessionKey: root.sessionKey,
              rootSessionId: root.sessionId,
              rootSessionLifecycleRevision: "root-first",
            },
            forkSource: { sessionKey: source.sessionKey, sessionId: source.sessionId },
          });
        } else {
          await expect(operation).rejects.toThrow(
            "Conversation root changed before branch admission",
          );
          expect(loadSessionEntry(target)).toBeUndefined();
          expect(await loadTranscriptEvents(target)).toEqual([]);
        }
        expect(loadSessionEntry(root)?.sessionId).toBe(root.sessionId);
      });
    },
  );
  it("commits copied events with the real ingress row without borrowing its source's rights", async () => {
    await withContext(async ({ source, target, commit }) => {
      const sql = observeHostDataSql();
      const publication = observeCreation(target.sessionKey);
      const result = await commit().finally(() => {
        sql.restore();
        publication.stop();
      });
      expect(sql.queries, "initial context caller-thread SQL").toEqual([]);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Synthetic initial context conflicted");
      }
      const entry = loadSessionEntry(target)!;
      expect(entry).toMatchObject({
        sessionId: target.sessionId,
        chatType: "group",
        sandbox: "required",
        permissionMode: "workspace",
        createdActor: { type: "human", source: "channel", id: "target-caller" },
        forkSource: {
          sessionKey: source.sessionKey,
          sessionId: source.sessionId,
          entryId: expect.any(String),
        },
        totalTokensFresh: false,
      });
      // The durable JSON representation omits optional own keys whose value is undefined.
      // Assert the entire persisted route, not an in-memory normalizer's undefined keys.
      expect(entry.delivery).toStrictEqual({
        kind: "external",
        route: { channel: "matrix", target: { to: "room:synthetic" } },
        context: { channel: "matrix", to: "room:synthetic" },
        origin: { provider: "matrix", to: "room:synthetic" },
      });
      expect(entry.totalTokens).toBeUndefined();
      expect(entry.parentSessionKey).toBeUndefined();
      expect(entry.spawnedBy).toBeUndefined();
      expect(entry.cliSessionBindings).toBeUndefined();
      expect(entry.cliSessionIds).toBeUndefined();
      expect(entry.claudeCliSessionId).toBeUndefined();
      expect(result.sessionEntry).toEqual(entry);
      expect(result.sessionStoreView[target.sessionKey]).toEqual(entry);
      expect(publication.rowIds).toContain(target.sessionId);
      expect(publication.transcripts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionKey: target.sessionKey, sessionId: target.sessionId }),
        ]),
      );
      const events = await loadTranscriptEvents(target);
      expect(JSON.stringify(events)).toContain("Completed context");
      expect(events[0]).toMatchObject({ type: "session", id: target.sessionId });
    });
  });

  it.each(["incarnation", "transcript"] as const)(
    "refuses changed source %s without creating a partial target",
    async (change) => {
      await withContext(async ({ source, target, commit }) => {
        if (change === "incarnation") {
          await upsertSessionEntryCore(source, {
            ...loadSessionEntry(source)!,
            lifecycleRevision: "replacement",
          });
        } else {
          await replaceTranscriptEvents(source, [
            { type: "session", id: source.sessionId, version: 3 },
          ]);
        }
        await expect(commit()).rejects.toThrow(
          change === "incarnation"
            ? "Synthetic source read witness changed"
            : "Session transcript changed during context read",
        );
        expect(loadSessionEntry(target)).toBeUndefined();
        expect(await loadTranscriptEvents(target)).toEqual([]);
      });
    },
  );

  it("accepts later append-only source work without copying its new pending instruction", async () => {
    await withContext(async ({ source, target, commit }) => {
      await appendTranscriptMessage(source, {
        message: { role: "user", content: "A later pending instruction" },
      });
      expect((await commit()).ok).toBe(true);
      const events = JSON.stringify(await loadTranscriptEvents(target));
      expect(events).toContain("Completed context");
      expect(events).not.toContain("A later pending instruction");
    });
  });

  it("rejects source path navigation even when its generation and original bytes survive", async () => {
    await withContext(async ({ source, target, commit }) => {
      await appendTranscriptEvent(source, {
        type: "leaf",
        id: "new-path",
        parentId: null,
        targetId: null,
        appendParentId: null,
        timestamp: new Date(0).toISOString(),
      });
      await expect(commit()).rejects.toThrow("Session transcript changed during context read");
      expect(loadSessionEntry(target)).toBeUndefined();
      expect(await loadTranscriptEvents(target)).toEqual([]);
    });
  });

  it("preserves a competing target instead of appending context twice", async () => {
    await withContext(async ({ target, commit }) => {
      const result = await commit({
        beforeEntryMutation: async () => {
          await upsertSessionEntryCore(target, {
            sessionId: "competing-session",
            updatedAt: 3,
            label: "competing conversation",
          });
        },
      });
      expect(result).toMatchObject({ ok: false, reason: "stale-snapshot" });
      expect(loadSessionEntry(target)?.sessionId).toBe("competing-session");
      expect(await loadTranscriptEvents(target)).toEqual([]);
    });
  });

  it("refuses a substituted completed endpoint even when the source version is unchanged", async () => {
    await withContext(async ({ target, context, commit }) => {
      if (!context.sourceThrough) {
        throw new Error("Synthetic source anchor was not prepared");
      }
      await expect(
        commit({
          initialContext: {
            ...context,
            sourceThrough: { ...context.sourceThrough, rawSeq: context.sourceThrough.rawSeq + 1 },
          },
        }),
      ).rejects.toThrow("Completed-turn transcript anchor changed");
      expect(loadSessionEntry(target)).toBeUndefined();
      expect(await loadTranscriptEvents(target)).toEqual([]);
    });
  });

  it("refuses a retained hidden target transcript even without a visible entry", async () => {
    await withContext(async ({ target, commit }) => {
      await appendTranscriptEvent(target, { type: "session", id: target.sessionId, version: 3 });
      const before = await loadTranscriptEvents(target);
      expect(loadSessionEntry(target)).toBeUndefined();
      await expect(commit()).rejects.toThrow("unused target transcript");
      expect(await loadTranscriptEvents(target)).toEqual(before);
      expect(loadSessionEntry(target)).toBeUndefined();
    });
  });

  it("rolls back an appended prefix when later event encoding fails", async () => {
    await withContext(async ({ target, context, commit }) => {
      const publication = observeCreation(target.sessionKey);
      try {
        await expect(
          commit({
            initialContext: {
              ...context,
              // BigInt crosses the worker channel but cannot become transcript JSON.
              events: [...context.events, { type: "custom", id: "invalid", data: 1n }],
            },
          }),
        ).rejects.toThrow();
      } finally {
        publication.stop();
      }
      expect(publication.rowIds).toEqual([]);
      expect(publication.transcripts).toEqual([]);
      expect(loadSessionEntry(target)).toBeUndefined();
      expect(await loadTranscriptEvents(target)).toEqual([]);
      // The same intended identity is still unused after the rolled-back append.
      expect((await commit()).ok).toBe(true);
    });
  });

  it.each(["model-lock", "physical-source"] as const)(
    "refuses an inadmissible %s before target creation",
    async (change) => {
      await withContext(async ({ source, target, context, commit }) => {
        if (change === "model-lock") {
          await upsertSessionEntryCore(source, {
            ...loadSessionEntry(source)!,
            modelSelectionLocked: true,
          });
          await expect(commit()).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
        } else {
          const other = { ...source, storePath: state.statePath("separate", "sessions.sqlite") };
          await upsertSessionEntryCore(other, loadSessionEntry(source)!);
          await withSessionEntryReadOnlyInWorker(
            other,
            () => {},
            async (read, owner) => {
              if (!read.ok || !owner.source || typeof owner.source.databaseIdentity !== "string") {
                throw new Error("Synthetic physical source was not admitted");
              }
              await expect(
                commit({
                  initialContext: {
                    ...context,
                    source: { ...owner.source, databaseIdentity: owner.source.databaseIdentity },
                  },
                }),
              ).rejects.toThrow("matching prepared donor read authority");
            },
          );
        }
        expect(loadSessionEntry(target)).toBeUndefined();
        expect(await loadTranscriptEvents(target)).toEqual([]);
      });
    },
  );

  it("requires prepared source authority rather than treating snapshot data as authority", async () => {
    await withContext(async ({ target, commit }) => {
      await expect(commit({ contextSourceAuthority: undefined })).rejects.toThrow(
        "retained source authority",
      );
      await expect(commit({ contextSourceAuthority: () => {} })).rejects.toThrow(
        "retained source authority",
      );
      expect(loadSessionEntry(target)).toBeUndefined();
    });
  });

  it("pins the snapshot data before awaited preparation can mutate its carrier", async () => {
    await withContext(async ({ target, context, commit }) => {
      const result = await commit({
        beforeEntryMutation: () => {
          context.sourceSessionKey = "agent:main:not-the-source";
          context.events = [];
        },
      });
      expect(result.ok).toBe(true);
      expect(JSON.stringify(await loadTranscriptEvents(target))).toContain("Completed context");
    });
  });

  it("rechecks retained source authority after awaited preparation", async () => {
    await withContext(async ({ target, commit }) => {
      let current = true;
      await expect(
        commit({
          commitGuard: () => {
            if (!current) {
              throw new Error("Synthetic source authority revoked");
            }
          },
          beforeEntryMutation: () => {
            current = false;
          },
        }),
      ).rejects.toThrow("source authority revoked");
      expect(loadSessionEntry(target)).toBeUndefined();
      expect(await loadTranscriptEvents(target)).toEqual([]);
    });
  });
});
