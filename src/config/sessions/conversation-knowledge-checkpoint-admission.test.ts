import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { conversationKnowledgeParticipantIdentity } from "./conversation-audience.js";
import {
  prepareConversationKnowledgeBootstrap,
  advanceConversationKnowledgeBootstrapInput,
  prepareNewConversationKnowledgeBootstrap,
  prepareConversationKnowledgeCheckpointSelection,
  PreparedConversationKnowledgeCheckpointSelection,
  retainConversationKnowledgeCheckpoint,
} from "./conversation-knowledge-checkpoint-admission.js";
import {
  CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT,
  createConversationKnowledgeCheckpointContext,
} from "./conversation-knowledge-checkpoint-context.js";
import {
  appendConversationKnowledgeCheckpoint,
  readLatestConversationKnowledgeCheckpoint,
  readConversationKnowledgeCheckpointCoverage,
  readConversationKnowledgeCheckpointById,
} from "./conversation-knowledge-checkpoint-store.js";
import {
  createConversationKnowledgeCheckpoint,
  prepareConversationKnowledgeCheckpointCoverage,
} from "./conversation-knowledge-checkpoint.js";
import { conversationKnowledgeContributionId } from "./conversation-knowledge-identity.js";
import {
  createConversationKnowledgePacketReport,
  readActiveConversationKnowledgePacketIds,
  readConversationKnowledgePacketProgress,
} from "./conversation-knowledge-packets.js";
import { selectConversationKnowledgeReceipts } from "./conversation-knowledge-selection.js";
import {
  issuePreparedKnowledgeRootCandidates,
  readConversationKnowledgeRoot,
  readPreparedConversationKnowledgeRoot,
  readPreparedConversationKnowledgeRootEvidence,
  recordConversationUtteranceObservation,
  type ConversationKnowledgeBranch,
} from "./conversation-knowledge-store.js";
import {
  conversationKnowledgeOrigin,
  projectConversationKnowledge,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import { withSessionTranscriptDeltaReader } from "./session-transcript-delta-read.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";

describe("native conversation checkpoint storage and admission", () => {
  it("commits summary and coverage together, resumes after compaction, and rejects competing bootstrap", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "knowledge-checkpoint" },
      async (state) => {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const base = { agentId: "main", storePath: database.path, env: state.env };
        const root = {
          sessionKey: "agent:main:checkpoint-root",
          sessionId: "root-instance",
          lifecycleRevision: "root-life",
        };
        const branch: ConversationKnowledgeBranch = {
          ...base,
          sessionKey: "agent:main:checkpoint-recipient",
          sessionId: "recipient-instance",
          lifecycleRevision: "recipient-life",
          root,
        };
        const racing: ConversationKnowledgeBranch = {
          ...branch,
          sessionKey: "agent:main:checkpoint-racing",
          sessionId: "racing-instance",
        };
        const sealed: ConversationKnowledgeBranch = {
          ...branch,
          sessionKey: "agent:main:checkpoint-sealed",
          sessionId: "sealed-instance",
        };
        const donor = {
          ...base,
          sessionKey: "agent:main:checkpoint-donor",
          sessionId: "donor-instance",
          lifecycleRevision: "donor-life",
        };
        for (const target of [root, branch, racing, sealed, donor]) {
          await upsertSessionEntryCore(
            { ...base, ...target },
            {
              sessionId: target.sessionId,
              lifecycleRevision: target.lifecycleRevision,
              updatedAt: 1,
              ...(target === root
                ? {
                    createdVia: "internal" as const,
                    createdActor: { type: "system" as const, id: "conversation-root" },
                    visibility: "draft" as const,
                    delivery: { kind: "none" as const },
                  }
                : {}),
              conversationTopology:
                target === root
                  ? { version: 1, role: "root" }
                  : {
                      version: 1,
                      role: "branch",
                      rootSessionKey: root.sessionKey,
                      rootSessionId: root.sessionId,
                      rootSessionLifecycleRevision: root.lifecycleRevision,
                    },
            },
          );
        }
        const person = { type: "profile", id: "example-person" } as const;
        const audienceKey = conversationKnowledgeParticipantIdentity(person)!;
        const saved = appendTranscriptMessageSync(donor, {
          message: {
            role: "user",
            content: "The synthetic preferred color is blue.",
            timestamp: 1,
          },
        });
        if (!saved.ok || !saved.value?.anchor) {
          throw new Error("Synthetic source anchor missing");
        }
        const reference: ConversationKnowledgeReference = {
          version: 1,
          kind: "utterance-observation",
          role: "user",
          sourceMode: "branches",
          source: donor,
          origin: conversationKnowledgeOrigin(donor, "utterance-observation"),
          through: saved.value.anchor,
          privateAudience: { participant: person, admission: saved.value.anchor },
        };
        const checkpoint = createConversationKnowledgeCheckpoint({
          branch,
          audienceKey,
          covered: [reference],
          summary: "The user's preferred color is blue.",
        });
        const coverage = prepareConversationKnowledgeCheckpointCoverage({
          checkpoint,
          records: [checkpoint],
          assertCurrent: () => {},
        });
        for (const target of [branch, racing, sealed]) {
          expect(
            appendTranscriptMessageSync(target, {
              message: { role: "user", content: "A separate local request.", timestamp: 2 },
            }).ok,
          ).toBe(true);
        }
        const held = await loadSessionEntryForAdmission(branch);
        if (
          !("kind" in held.databaseClaim) ||
          held.databaseClaim.kind !== "worker" ||
          !held.databaseClaim.reader
        ) {
          await held.databaseClaim.release();
          throw new Error("Synthetic worker cohort missing");
        }
        const assertCurrent = () => held.databaseClaim.assertCurrent();
        const authority: SessionSourceAssertion = Object.assign(assertCurrent, {
          prepareSessionSource: async () => ({ assertCurrent, checks: [] }),
        });
        const records = async (target: ConversationKnowledgeBranch) =>
          (await loadTranscriptEvents(target))
            .map(asOptionalRecord)
            .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CHECKPOINT_CONTEXT);
        const retain = async (target = branch, source = authority) => {
          const targetHeld = target === branch ? held : await loadSessionEntryForAdmission(target);
          try {
            if (
              !("kind" in targetHeld.databaseClaim) ||
              targetHeld.databaseClaim.kind !== "worker" ||
              !targetHeld.databaseClaim.reader
            ) {
              throw new Error("Synthetic target worker cohort missing");
            }
            const bootstrap = await prepareConversationKnowledgeBootstrap({
              branch: target,
              env: state.env,
              source,
            });
            if (!bootstrap) return { accepted: false, appended: false, deferred: false };
            return await retainConversationKnowledgeCheckpoint({
              branch: target,
              checkpoint,
              coverage,
              audienceKey,
              availableReferences: [reference],
              writeTarget: target,
              reader: targetHeld.databaseClaim.reader,
              bootstrap,
              source,
            });
          } finally {
            if (targetHeld !== held) await targetHeld.databaseClaim.release();
          }
        };
        try {
          await appendConversationKnowledgeCheckpoint({ branch, checkpoint, source: authority });
          await appendConversationKnowledgeCheckpoint({ branch, checkpoint, source: authority });
          expect(
            await readLatestConversationKnowledgeCheckpoint({
              branch,
              audienceKey,
              source: authority,
            }),
          ).toEqual(checkpoint);
          const persistedCoverage = await readConversationKnowledgeCheckpointCoverage({
            branch,
            checkpoint,
            source: authority,
            reader: held.databaseClaim.reader,
          });
          expect(
            await readConversationKnowledgeCheckpointCoverage({
              branch,
              checkpoint,
              source: authority,
              reader: held.databaseClaim.reader,
            }),
          ).toBe(persistedCoverage);
          await expect(
            readConversationKnowledgeCheckpointCoverage({
              branch,
              checkpoint,
              reader: held.databaseClaim.reader,
              source: () => {
                throw new Error("Synthetic source revoked");
              },
            }),
          ).rejects.toThrow("Synthetic source revoked");
          expect([...persistedCoverage.contributionIds()]).toEqual([...coverage.contributionIds()]);
          const second = appendTranscriptMessageSync(donor, {
            message: { role: "user", content: "The later preference is green.", timestamp: 2 },
          });
          if (!second.ok || !second.value?.anchor)
            throw new Error("Second synthetic anchor missing");
          const nextReference: ConversationKnowledgeReference = {
            ...reference,
            through: second.value.anchor,
            privateAudience: { participant: person, admission: second.value.anchor },
          };
          const candidate = (summary: string) =>
            createConversationKnowledgeCheckpoint({
              branch,
              audienceKey,
              previous: checkpoint,
              previousCoverage: coverage,
              covered: [nextReference],
              summary,
            });
          const competing = await Promise.allSettled([
            appendConversationKnowledgeCheckpoint({
              branch,
              checkpoint: candidate("First summary candidate."),
              previousCoverage: coverage,
              source: authority,
            }),
            appendConversationKnowledgeCheckpoint({
              branch,
              checkpoint: candidate("Second summary candidate."),
              previousCoverage: coverage,
              source: authority,
            }),
          ]);
          expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
          expect(
            await readConversationKnowledgeCheckpointById({
              branch,
              checkpointId: checkpoint.checkpointId,
              source: authority,
            }),
          ).toEqual(checkpoint);
          expect(
            (
              await readLatestConversationKnowledgeCheckpoint({
                branch,
                audienceKey,
                source: authority,
              })
            )?.checkpointId,
          ).not.toBe(checkpoint.checkpointId);
          const staleBootstrap = await prepareConversationKnowledgeBootstrap({
            branch,
            env: state.env,
            source: authority,
          });
          expect(staleBootstrap).toBeDefined();
          expect(() => staleBootstrap!.version(racing)).toThrow("recipient changed");
          const interveningInput = appendTranscriptMessageSync(branch, {
            message: {
              role: "user",
              content: "An input arrived after background preparation.",
              timestamp: 3,
            },
          });
          if (!interveningInput.ok || !interveningInput.value?.anchor)
            throw new Error("Synthetic native input anchor missing");
          const admission = {
            ...interveningInput.value.anchor,
            role: "user" as const,
            logicalTurnId: "synthetic-current-turn",
          };
          await expect(
            retainConversationKnowledgeCheckpoint({
              branch,
              checkpoint,
              coverage,
              audienceKey,
              availableReferences: [reference],
              bootstrap: staleBootstrap!,
              writeTarget: branch,
              reader: held.databaseClaim.reader,
              source: authority,
            }),
          ).rejects.toThrow();
          expect(await records(branch)).toHaveLength(0);
          expect(
            await advanceConversationKnowledgeBootstrapInput({
              branch,
              bootstrap: staleBootstrap!,
              admission: { ...admission, entryId: "another-input" },
              env: state.env,
              source: authority,
            }),
          ).toBeUndefined();
          const advanced = await advanceConversationKnowledgeBootstrapInput({
            branch,
            bootstrap: staleBootstrap!,
            admission,
            env: state.env,
            source: authority,
          });
          expect(advanced).toBeDefined();
          expect(
            (
              await retainConversationKnowledgeCheckpoint({
                branch,
                checkpoint,
                coverage,
                audienceKey,
                availableReferences: [reference],
                bootstrap: advanced!,
                writeTarget: branch,
                reader: held.databaseClaim.reader,
                source: authority,
              })
            ).appended,
          ).toBe(true);
          expect(await records(branch)).toHaveLength(1);
          const contributionId = conversationKnowledgeContributionId(reference);
          const progress = () =>
            readConversationKnowledgePacketProgress({
              branch,
              assertCurrent,
              checkpointCoverage: new Map([[checkpoint.checkpointId, coverage]]),
            });
          expect((await progress()).get(contributionId)).toEqual({
            complete: true,
            nextOffset: 0,
            coverage: "summary",
          });
          const report = createConversationKnowledgeCheckpointContext({ checkpoint, branch });
          expect(await readActiveConversationKnowledgePacketIds({ branch, assertCurrent })).toEqual(
            [report.details.packetId],
          );

          const partial = createConversationKnowledgePacketReport({
            branch,
            receipt: reference,
            text: projectConversationKnowledge(reference, await loadTranscriptEvents(donor))!.text,
            offset: 0,
            nextOffset: 4,
            complete: false,
          });
          expect(
            appendTranscriptEventSync(branch, {
              type: "custom_message",
              id: "ordinary-after-summary",
              ...partial,
            }).ok,
          ).toBe(true);
          expect((await progress()).get(contributionId)).toEqual({
            complete: true,
            nextOffset: 0,
            coverage: "summary",
          });
          const kept = appendTranscriptMessageSync(branch, {
            message: { role: "user", content: "Keep this active local question.", timestamp: 3 },
          });
          if (!kept.ok || !kept.value?.anchor) {
            throw new Error("Synthetic kept anchor missing");
          }
          expect(
            appendTranscriptEventSync(branch, {
              type: "compaction",
              id: "checkpoint-recipient-compaction",
              summary: "Local dialogue and imported blue preference.",
              firstKeptEntryId: kept.value.anchor.entryId,
              tokensBefore: 100,
            }).ok,
          ).toBe(true);
          expect((await progress()).get(contributionId)).toEqual({
            complete: true,
            nextOffset: 0,
            coverage: "summary",
          });
          expect(await readActiveConversationKnowledgePacketIds({ branch, assertCurrent })).toEqual(
            [],
          );
          expect((await retain()).appended).toBe(false);
          expect(await records(branch)).toHaveLength(1);

          const wrongRoot = createConversationKnowledgeCheckpointContext({
            checkpoint: createConversationKnowledgeCheckpoint({
              branch: { ...branch, root: { ...root, sessionId: "another-root" } },
              audienceKey,
              covered: [reference],
              summary: "Another root.",
            }),
            branch: { ...branch, root: { ...root, sessionId: "another-root" } },
          });
          expect(
            appendTranscriptEventSync(racing, {
              type: "custom_message",
              id: "wrong-root-carrier",
              ...wrongRoot,
            }).ok,
          ).toBe(true);
          expect(
            appendTranscriptEventSync(racing, {
              type: "custom_message",
              id: "invalid-carrier",
              ...report,
              details: { ...report.details, summaryDigest: "invalid" },
            }).ok,
          ).toBe(true);
          expect(
            await readConversationKnowledgePacketProgress({ branch: racing, assertCurrent }),
          ).toEqual(new Map());
          expect(
            await readActiveConversationKnowledgePacketIds({ branch: racing, assertCurrent }),
          ).toEqual([]);

          let injected = false;
          const racingAuthority: SessionSourceAssertion = Object.assign(() => assertCurrent(), {
            prepareSessionSource: async () => {
              if (!injected) {
                injected = true;
                expect(
                  appendTranscriptEventSync(racing, {
                    type: "custom_message",
                    id: "racing-ordinary-packet",
                    ...partial,
                  }).ok,
                ).toBe(true);
              }
              return { assertCurrent, checks: [] };
            },
          });
          await expect(retain(racing, racingAuthority)).rejects.toThrow(
            SessionTranscriptReadFenceError,
          );
          expect(injected).toBe(true);
          // Only the two deliberately invalid carriers remain; no stale bootstrap was added.
          expect(await records(racing)).toHaveLength(2);
          expect(
            (await readConversationKnowledgePacketProgress({ branch: racing, assertCurrent })).get(
              contributionId,
            ),
          ).toEqual({ complete: false, nextOffset: 4 });
          for (const kind of [
            "assistant",
            "toolResult",
            "import",
            "reset",
            "compaction",
            "extra-user",
          ] as const) {
            const negative = {
              ...branch,
              sessionKey: `agent:main:bootstrap-${kind.toLowerCase()}`,
              sessionId: `bootstrap-${kind}`,
            };
            await upsertSessionEntryCore(negative, {
              sessionId: negative.sessionId,
              lifecycleRevision: negative.lifecycleRevision,
              updatedAt: 1,
            });
            const initial = appendTranscriptMessageSync(negative, {
              message: { role: "user", content: "Original local input.", timestamp: 1 },
            });
            if (!initial.ok || !initial.value?.anchor)
              throw new Error("Negative bootstrap fixture lacks native anchor");
            const initialBootstrap = await prepareNewConversationKnowledgeBootstrap({
              branch: negative,
              env: state.env,
              source: authority,
              admission: {
                ...initial.value.anchor,
                role: "user",
                logicalTurnId: "first-original-input",
              },
            });
            if (!initialBootstrap) {
              const facts = await prepareSessionTranscriptHydration(negative).readMaintenance({
                operation: "version",
              });
              const raw = await withSessionTranscriptDeltaReader(negative, (reader) =>
                reader.raw({ maxEvents: 5, maxBytes: 1_000_000 }),
              );
              throw new Error(
                `Native initial bootstrap fixture differs: ${JSON.stringify({
                  kind,
                  expectedLifecycle: negative.lifecycleRevision,
                  anchor: initial.value.anchor,
                  facts,
                  page:
                    raw.kind === "page"
                      ? {
                          hasMore: raw.hasMore,
                          requiredBytes: raw.requiredBytes,
                          events: raw.events.map((row) => {
                            const event = asOptionalRecord(row.event);
                            return {
                              seq: row.seq,
                              type: event?.type,
                              id: event?.id,
                              parentId: event?.parentId,
                              role: asOptionalRecord(event?.message)?.role,
                            };
                          }),
                        }
                      : { kind: raw.kind },
                })}`,
              );
            }
            expect(initialBootstrap).toBeDefined();
            const proof = await prepareConversationKnowledgeBootstrap({
              branch: negative,
              env: state.env,
              source: authority,
            });
            expect(proof).toBeDefined();
            const previous = initial.value.anchor;
            let id = `unexpected-${kind}`;
            if (kind === "assistant" || kind === "toolResult" || kind === "extra-user") {
              const appended = appendTranscriptMessageSync(negative, {
                message: {
                  role: kind === "extra-user" ? "user" : kind,
                  content: "Other activity.",
                  timestamp: 2,
                },
              });
              if (!appended.ok || !appended.value?.anchor)
                throw new Error("Native negative message fixture failed");
              id = appended.value.anchor.entryId;
            } else {
              const event =
                kind === "import"
                  ? { type: "custom_message", id, parentId: previous.entryId, ...partial }
                  : {
                      type: kind,
                      id,
                      parentId: previous.entryId,
                      timestamp: new Date(2).toISOString(),
                      summary: "Native navigation boundary.",
                      firstKeptEntryId: previous.entryId,
                      tokensBefore: 1,
                    };
              expect(appendTranscriptEventSync(negative, event).ok).toBe(true);
            }
            if (kind === "extra-user")
              expect(
                appendTranscriptMessageSync(negative, {
                  message: { role: "user", content: "A second separate input.", timestamp: 3 },
                }).ok,
              ).toBe(true);
            expect(
              await advanceConversationKnowledgeBootstrapInput({
                branch: negative,
                bootstrap: proof!,
                env: state.env,
                source: authority,
                admission: {
                  ...previous,
                  entryId: id,
                  rawSeq: previous.rawSeq + 1,
                  effectiveParentId: previous.entryId,
                  role: "user",
                  logicalTurnId: "expected-turn",
                },
              }),
            ).toBeUndefined();
            expect(
              await prepareNewConversationKnowledgeBootstrap({
                branch: negative,
                env: state.env,
                source: authority,
              }),
            ).toBeUndefined();
          }
          // Real native root publication -> immutable selected scope -> sealed
          // admission. The legacy path above remains independently exercised.
          const donorHeld = await loadSessionEntryForAdmission(donor);
          const sealedHeld = await loadSessionEntryForAdmission(sealed);
          try {
            if (
              !("kind" in donorHeld.databaseClaim) ||
              donorHeld.databaseClaim.kind !== "worker" ||
              !donorHeld.databaseClaim.reader ||
              !("kind" in sealedHeld.databaseClaim) ||
              sealedHeld.databaseClaim.kind !== "worker" ||
              !sealedHeld.databaseClaim.reader
            )
              throw new Error("Native sealed fixture requires worker cohorts");
            expect(
              await recordConversationUtteranceObservation({
                reader: donorHeld.databaseClaim.reader,
                assertCurrent: () => donorHeld.databaseClaim.assertCurrent(),
                sessionId: donor.sessionId,
                anchor: saved.value.anchor,
                role: "user",
                sourceMode: "branches",
                privateAudience: reference.privateAudience,
              }),
            ).toBe(true);
            const reader = sealedHeld.databaseClaim.reader;
            const sealedAuthority: SessionSourceAssertion = Object.assign(
              () => sealedHeld.databaseClaim.assertCurrent(),
              {
                prepareSessionSource: async () => ({
                  assertCurrent: () => sealedHeld.databaseClaim.assertCurrent(),
                  checks: [],
                }),
              },
            );
            const nativeRoot = await readConversationKnowledgeRoot({
              branch: sealed,
              reader,
              assertCurrent: sealedAuthority,
            });
            const exact = selectConversationKnowledgeReceipts(
              nativeRoot,
              sealed.sessionId,
              sealed.sessionKey,
              "branches",
              sealed.lifecycleRevision,
            ).filter((item) => coverage.has(conversationKnowledgeContributionId(item)));
            expect(exact).toHaveLength(1);
            const manifest = issuePreparedKnowledgeRootCandidates(nativeRoot.evidence, exact, {
              maxBytes: 4 * 1024 * 1024,
              sharedMetadata: true,
            });
            const selected = await readPreparedConversationKnowledgeRoot({
              branch: sealed,
              reader,
              manifest,
              assertCurrent: sealedAuthority,
            });
            const selection = prepareConversationKnowledgeCheckpointSelection({
              branch: sealed,
              checkpoint,
              coverage,
              audienceKey,
              manifest,
              rootEvidence: selected.evidence!,
              availableReferences: exact,
              source: sealedAuthority,
            });
            expect(selection).toBeDefined();
            const rootEvidence = await readPreparedConversationKnowledgeRootEvidence({
              branch: sealed,
              reader,
              manifest,
              assertCurrent: sealedAuthority,
            });
            const bootstrap = await prepareConversationKnowledgeBootstrap({
              branch: sealed,
              env: state.env,
              source: sealedAuthority,
            });
            expect(bootstrap).toBeDefined();
            const input = {
              branch: sealed,
              checkpoint: selection!.checkpoint,
              coverage,
              audienceKey,
              manifest,
              rootEvidence,
              selection: selection!,
              bootstrap: bootstrap!,
              writeTarget: sealed,
              reader,
              source: sealedAuthority,
            };
            await expect(
              retainConversationKnowledgeCheckpoint({
                ...input,
                selection: {
                  validate: () => checkpoint,
                } as unknown as PreparedConversationKnowledgeCheckpointSelection,
              }),
            ).rejects.toThrow("verified preparation");
            await expect(
              retainConversationKnowledgeCheckpoint({ ...input, checkpoint }),
            ).rejects.toThrow("selection changed");
            await expect(
              retainConversationKnowledgeCheckpoint({
                ...input,
                branch: { ...sealed, lifecycleRevision: "changed-recipient" },
              }),
            ).rejects.toThrow("recipient changed");
            expect(await records(sealed)).toHaveLength(0);
            expect((await retainConversationKnowledgeCheckpoint(input)).appended).toBe(true);
            expect(await records(sealed)).toHaveLength(1);
            // The successful append itself invalidates the exact bootstrap version.
            await expect(retainConversationKnowledgeCheckpoint(input)).rejects.toThrow(
              SessionTranscriptReadFenceError,
            );
            expect(await records(sealed)).toHaveLength(1);
            await upsertSessionEntryCore(
              { ...base, ...root },
              { lifecycleRevision: "revoked-root-life" },
            );
            await expect(
              readPreparedConversationKnowledgeRootEvidence({
                branch: sealed,
                reader,
                manifest,
                assertCurrent: sealedAuthority,
              }),
            ).rejects.toThrow("root changed");
          } finally {
            await sealedHeld.databaseClaim.release();
            await donorHeld.databaseClaim.release();
          }
        } finally {
          await held.databaseClaim.release();
        }
      },
    );
  });
});
