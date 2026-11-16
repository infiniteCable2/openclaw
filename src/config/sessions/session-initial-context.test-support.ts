import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { conversationKnowledgeParticipantIdentity } from "./conversation-audience.js";
import { appendConversationKnowledgeCheckpoint } from "./conversation-knowledge-checkpoint-store.js";
import { createConversationKnowledgeCheckpoint } from "./conversation-knowledge-checkpoint.js";
import {
  conversationKnowledgeOrigin,
  projectConversationKnowledge,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
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
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

/** Keep native storage, authority and initial-copy setup under the test's existing lifetime. */
export function createInitialContextFixture(
  getState: () => OpenClawTestState,
  nextId: () => number,
) {
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
    const state = getState();
    const id = nextId();
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
        donorChecks: () => number;
      },
    ) => Promise<void>,
    options?: { checkpointOnly?: boolean },
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
        const originals: TranscriptEntryAnchor[] = [];
        for (const [index, text] of [
          "A summarized earlier fact.",
          "A later original fact.",
        ].entries()) {
          const original = await appendTranscriptMessage(donor, {
            message: { role: "user", content: text, timestamp: index === 0 ? 2 : 1 },
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
            let donorChecks = 0;
            const donorAuthority: SessionSourceAssertion = Object.assign(
              () => {
                donorChecks++;
                owner.assertCurrent();
              },
              {
                prepareSessionSource: async (): Promise<PreparedSessionSourceAuthority> => ({
                  assertCurrent: donorAuthority,
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
            const publicationAuthority = composeSessionSourceAssertion([
              fixture.authority,
              donorAuthority,
            ]);
            const authority = options?.checkpointOnly ? fixture.authority : publicationAuthority;
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
            await appendConversationKnowledgeCheckpoint({
              branch,
              checkpoint,
              source: publicationAuthority,
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
              claims: options?.checkpointOnly
                ? []
                : [
                    {
                      reference: references[1]!,
                      predicate: { ...predicate, fields: [...predicate.fields] },
                      sessionId: donor.sessionId,
                      version: donorFacts.contextVersion,
                      through: originals[1]!,
                      from: originals[1]!,
                    },
                  ],
              packets: options?.checkpointOnly
                ? []
                : [
                    {
                      receipt: references[1]!,
                      text: part.text,
                      offset: 0,
                      nextOffset: part.nextOffset ?? 0,
                      complete: part.complete,
                      sourceClaim: 0,
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
              donorChecks: () => donorChecks,
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
  return { withContext, withProjectedContext };
}
