import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { resolveEmbeddedSessionContextLimits } from "../../agents/embedded-agent-runner/run/session-context-limits.js";
import { CONVERSATION_KNOWLEDGE_CONTEXT } from "../../config/sessions/conversation-knowledge-packets.js";
import {
  readConversationKnowledgeBranch,
  recordConversationKnowledgeTurn,
} from "../../config/sessions/conversation-knowledge-store.js";
import type { ConversationKnowledgeFrontier } from "../../config/sessions/conversation-knowledge.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import { assertExternalConversationTarget } from "../../routing/conversation-mode.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";
import {
  createConversationKnowledgeScenario,
  otherPerson,
  person,
} from "./conversation-knowledge.scenario.test-support.js";

describe("ordered native branch Knowledge scenario", () => {
  it("keeps committed differences, personal authority and the headless root consistent", async ({
    signal,
  }) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "branch-knowledge-scenario" },
      async (state) => {
        const fixture = await createConversationKnowledgeScenario(state);
        const trace: string[] = [];
        const step = async (label: string, body: () => Promise<void>) => {
          await body();
          trace.push(label);
          console.info(`[branch-knowledge scenario] ${label}`);
        };
        try {
          const a = await fixture.branch("a");
          const b = await fixture.branch("b");
          const ownerA = await fixture.claim(a);
          const ownerB = await fixture.claim(b);
          let fromA: ConversationKnowledgeFrontier[] = [];
          let fromB: ConversationKnowledgeFrontier[] = [];
          await step("01 root + equal private branches admitted", async () => {
            expect((await readConversationKnowledgeBranch(ownerA))?.root.sessionKey).toBe(
              fixture.root.sessionKey,
            );
            expect((await readConversationKnowledgeBranch(ownerB))?.root.sessionKey).toBe(
              fixture.root.sessionKey,
            );
            expect(a.sessionKey).not.toContain(":subagent:");
            expect(b.sessionKey).not.toContain(":subagent:");
            expect((await fixture.read(ownerB)).text).toBe("");
          });
          await step("02 A committed turn becomes one opaque receipt", async () => {
            const terminal = await fixture.append(a, "a-one");
            expect(await recordConversationKnowledgeTurn({ ...ownerA, ...terminal })).toBe(true);
            expect(await recordConversationKnowledgeTurn({ ...ownerA, ...terminal })).toBe(true);
            expect(await fixture.receipts()).toHaveLength(1);
          });
          await step("03 B reads A as neutral data, not a new instruction", async () => {
            const knowledge = await fixture.read(ownerB);
            expect(knowledge.text).toContain("a-one answer");
            expect(knowledge.text).toContain("not new requests");
            expect(knowledge.text).toContain('"sourceAudience":"private-direct"');
            fromA = knowledge.observed;
            expect(fromA).toHaveLength(1);
          });
          await step("04 B commits its own reply and persisted observed frontier", async () => {
            const terminal = await fixture.append(b, "b-one");
            expect(
              await recordConversationKnowledgeTurn({ ...ownerB, ...terminal, observed: fromA }),
            ).toBe(true);
            expect((await fixture.receipts()).at(-1)?.observed).toEqual(fromA);
            const knowledge = await fixture.read(ownerA);
            expect(knowledge.text).toContain("b-one answer");
            expect(knowledge.text).not.toContain("a-one answer");
            fromB = knowledge.observed;
          });
          await step("05 newer A exchange advances B without replaying A-one", async () => {
            const terminal = await fixture.append(a, "a-two");
            expect(
              await recordConversationKnowledgeTurn({ ...ownerA, ...terminal, observed: fromB }),
            ).toBe(true);
            const knowledge = await fixture.read(ownerB);
            expect(knowledge.text).toContain("a-two answer");
            expect(knowledge.text).not.toContain("a-one answer");
            fromA = knowledge.observed;
            expect(new Set(fromA.map((frontier) => frontier.origin)).size).toBe(fromA.length);
          });
          await step("06 consumed frontier and duplicate report do not replay", async () => {
            const terminal = await fixture.append(b, "b-two");
            const report = { ...ownerB, ...terminal, observed: fromA };
            expect(await recordConversationKnowledgeTurn(report)).toBe(true);
            const count = (await fixture.receipts()).length;
            expect(await recordConversationKnowledgeTurn(report)).toBe(true);
            expect(await fixture.receipts()).toHaveLength(count);
            expect((await fixture.read(ownerB)).text).toBe("");
            const knowledge = await fixture.read(ownerA);
            expect(knowledge.text).toContain("b-two answer");
            expect(knowledge.text).not.toContain("b-one answer");
          });
          await step("07 pending and aborted work never produce completed knowledge", async () => {
            const count = (await fixture.receipts()).length;
            await appendTranscriptMessage(a, {
              message: { role: "user", content: "pending-only question" },
            });
            expect(
              await recordConversationKnowledgeTurn({
                ...ownerA,
                runId: "pending-only",
                assistantTranscriptIdempotencyKey: "pending-only:assistant",
              }),
            ).toBe(false);
            const aborted = await fixture.append(a, "aborted-only", "aborted");
            expect(await recordConversationKnowledgeTurn({ ...ownerA, ...aborted })).toBe(false);
            expect(await fixture.receipts()).toHaveLength(count);
            const resumed = await fixture.append(a, "a-resumed");
            expect(
              await recordConversationKnowledgeTurn({
                ...ownerA,
                ...resumed,
                observed: fromB,
              }),
            ).toBe(true);
            const knowledge = await fixture.read(ownerB);
            expect(knowledge.text).toContain("a-resumed answer");
            expect(knowledge.text).not.toContain("pending-only");
            expect(knowledge.text).not.toContain("aborted-only");
          });
          await step("08 foreign-person and group receipts grant no disclosure", async () => {
            const foreign = await fixture.branch("foreign", otherPerson);
            const group = await fixture.branch("group", person, "group");
            for (const selected of [foreign, group]) {
              const owner = await fixture.claim(selected);
              const terminal = await fixture.append(selected, selected.sessionId);
              expect(await recordConversationKnowledgeTurn({ ...owner, ...terminal })).toBe(true);
            }
            const knowledge = await fixture.read(ownerB);
            expect(knowledge.text).not.toContain("scenario-foreign answer");
            expect(knowledge.text).not.toContain("scenario-group answer");
            const foreignRead = await fixture.read(await fixture.claim(foreign), otherPerson);
            expect(foreignRead.text).not.toContain("a-resumed");
            expect(foreignRead.text).not.toContain("b-two");
            const groupRead = await fixture.read(await fixture.claim(group));
            expect(groupRead.text).toContain('"available":false');
          });
          await step("09 missing input person and unconfirmed audience fail closed", async () => {
            const unconfirmed = await fixture.branch("unconfirmed", null);
            // Omit the actual input person independently of stored ownership.
            const missing = await prepareReplyConversationKnowledge({
              ...ownerB,
              getRuntimeConfig: () => fixture.cfg,
            });
            try {
              expect(missing?.fragments[0]?.text).toContain("original-participant-unconfirmed");
              expect(missing?.observed).toEqual([]);
            } finally {
              missing?.release();
            }
            const knowledge = await fixture.read(await fixture.claim(unconfirmed));
            expect(knowledge.text).toContain("private-destination-audience-unconfirmed");
          });
          for (const mode of ["revoke", "replace"] as const) {
            await step(`10 ${mode} during native report preparation refuses commit`, async () => {
              const selected = await fixture.branch(`await-${mode}`);
              const owner = await fixture.claim(selected);
              const terminal = await fixture.append(selected, `await-${mode}`);
              const count = (await fixture.receipts()).length;
              const entered = createDeferred();
              const release = createDeferred();
              let intercepted = false;
              const source: SessionSourceAssertion = Object.assign(() => owner.assertCurrent(), {
                prepareSessionSource: async () => {
                  const prepared = await owner.assertCurrent.prepareSessionSource!();
                  if (!intercepted) {
                    intercepted = true;
                    entered.resolve();
                    await release.promise;
                  }
                  return prepared;
                },
              });
              const outcome = recordConversationKnowledgeTurn({
                ...owner,
                ...terminal,
                assertCurrent: source,
              });
              // Observe rejection immediately, so the intentional refusal cannot become unhandled.
              const settled = outcome.then(
                () => "committed",
                () => "refused",
              );
              try {
                await withinTest(
                  awaitGateBeforeSettlement(
                    entered.promise,
                    outcome,
                    "Native report settled without reaching original source preparation",
                  ),
                  signal,
                );
                if (mode === "revoke") {
                  owner.revoke();
                } else {
                  const previous = loadSessionEntry(selected);
                  if (!previous) {
                    throw new Error("Expected the actual original branch row");
                  }
                  await replaceSessionEntry(selected, {
                    ...previous,
                    lifecycleRevision: "replacement-life",
                  });
                }
              } finally {
                release.resolve();
                expect(await settled).toBe("refused");
              }
              expect(await fixture.receipts()).toHaveLength(count);
            });
          }
          await step(
            "11 headless root rejects external ingress and contains no dialogue",
            async () => {
              const entry = loadSessionEntry(fixture.root);
              expect(entry?.participantCount ?? 0).toBe(0);
              for (const cfg of [
                fixture.cfg,
                { ...fixture.cfg, agents: { entries: { main: {} } } },
              ]) {
                expect(() =>
                  assertExternalConversationTarget({
                    cfg,
                    agentId: "main",
                    sessionKey: fixture.root.sessionKey,
                    isSystemEvent: false,
                    entry,
                  }),
                ).toThrow("cannot receive external input");
              }
              const events = await loadTranscriptEvents(fixture.root);
              expect(events.some((event) => asOptionalRecord(event)?.type === "message")).toBe(
                false,
              );
              expect(JSON.stringify(events)).not.toContain("a-one question");
              expect(JSON.stringify(events)).not.toContain("b-two answer");
            },
          );
          await step(
            "12 durable catch-up resumes every authorized source without duplicate packets",
            async () => {
              const recipient = await fixture.branch("catch-up");
              // Old retained media can exceed native hydration without being new
              // catch-up growth. Keep new packet coverage independently visible.
              await appendTranscriptMessage(recipient, {
                message: {
                  role: "user",
                  content: [{ type: "image", mimeType: "image/png", data: "A".repeat(8_100_000) }],
                  timestamp: 1,
                },
              });
              await fixture.append(recipient, "old-image-reply");
              const owner = await fixture.claim(recipient);
              const contextLimits = resolveEmbeddedSessionContextLimits(1_000_000);
              for (let index = 0; index < 7; index += 1) {
                const donor = await fixture.branch(`donor-${index}`);
                const sourceOwner = await fixture.claim(donor);
                const terminal = await fixture.append(
                  donor,
                  `donor-${index}`,
                  "stop",
                  `donor-${index} ${"complete observation ".repeat(index === 0 ? 3_000 : 300)}`,
                );
                expect(await recordConversationKnowledgeTurn({ ...sourceOwner, ...terminal })).toBe(
                  true,
                );
              }
              const readPackets = async () =>
                (await loadTranscriptEvents(recipient))
                  .map(asOptionalRecord)
                  .filter((event) => event?.customType === CONVERSATION_KNOWLEDGE_CONTEXT);
              let maintenanceCalls = 0;
              await expect(
                prepareReplyConversationKnowledge({
                  ...owner,
                  originalParticipant: person,
                  getRuntimeConfig: () => fixture.cfg,
                  retainInHistory: {
                    writeTarget: recipient,
                    contextLimits,
                    maintainContext: async (source) => {
                      source();
                      maintenanceCalls += 1;
                      throw new Error("Synthetic interruption after durable admission");
                    },
                  },
                }),
              ).rejects.toThrow("Synthetic interruption after durable admission");
              expect(maintenanceCalls).toBe(1);
              const interruptedPackets = await readPackets();
              expect(interruptedPackets.length).toBeGreaterThan(0);
              const resumed = await prepareReplyConversationKnowledge({
                ...owner,
                originalParticipant: person,
                getRuntimeConfig: () => fixture.cfg,
                retainInHistory: {
                  writeTarget: recipient,
                  contextLimits,
                  maintainContext: async (source) => {
                    source();
                  },
                },
              });
              try {
                expect(resumed?.fragments).toEqual([]);
                expect(resumed?.observed).toEqual([]);
              } finally {
                resumed?.release();
              }
              const packets = await readPackets();
              const ids = packets.map((event) => asOptionalRecord(event?.details)?.packetId);
              expect(new Set(ids).size).toBe(ids.length);
              expect(packets.length).toBeGreaterThan(interruptedPackets.length);
              const hydrated = await prepareSessionTranscriptHydration(
                recipient,
                contextLimits,
                signal,
              ).read();
              expect(hydrated.kind).toBe("bounded");
              if (hydrated.kind !== "bounded") {
                throw new Error("Expected native bounded hydration");
              }
              expect(hydrated.snapshot.truncated).toBe(true);
              const visiblePacketIds = hydrated.snapshot.events.flatMap((event) => {
                const record = asOptionalRecord(event);
                return record?.customType === CONVERSATION_KNOWLEDGE_CONTEXT
                  ? [asOptionalRecord(record.details)?.packetId]
                  : [];
              });
              expect(new Set(visiblePacketIds)).toEqual(new Set(ids));
              const retainedText = JSON.stringify(packets);
              for (let index = 0; index < 7; index += 1) {
                expect(retainedText).toContain(`donor-${index}`);
              }
              let checkedExisting = false;
              const repeated = await prepareReplyConversationKnowledge({
                ...owner,
                originalParticipant: person,
                getRuntimeConfig: () => fixture.cfg,
                retainInHistory: {
                  writeTarget: recipient,
                  contextLimits,
                  maintainContext: async (source, activeIds) => {
                    source();
                    checkedExisting = true;
                    expect(new Set(activeIds)).toEqual(new Set(ids));
                    return { compacted: false, complete: true };
                  },
                },
              });
              repeated?.release();
              expect(checkedExisting).toBe(true);
              expect(await readPackets()).toHaveLength(packets.length);
              const lateDonor = await fixture.branch("late-donor");
              const lateOwner = await fixture.claim(lateDonor);
              const lateTerminal = await fixture.append(lateDonor, "late-observation");
              expect(await recordConversationKnowledgeTurn({ ...lateOwner, ...lateTerminal })).toBe(
                true,
              );
              const incomplete = await prepareReplyConversationKnowledge({
                ...owner,
                originalParticipant: person,
                getRuntimeConfig: () => fixture.cfg,
                retainInHistory: {
                  writeTarget: recipient,
                  contextLimits,
                  maintainContext: async (source) => {
                    source();
                    return { compacted: false, complete: false };
                  },
                },
              });
              try {
                expect(incomplete?.fragments).toEqual([
                  expect.objectContaining({
                    text: expect.stringContaining('"pending":"context-window"'),
                  }),
                ]);
                expect(JSON.stringify(await readPackets())).toContain("late-observation");
              } finally {
                incomplete?.release();
              }
              const beforeRecheck = await readPackets();
              const rechecked = await prepareReplyConversationKnowledge({
                ...owner,
                originalParticipant: person,
                getRuntimeConfig: () => fixture.cfg,
                retainInHistory: {
                  writeTarget: recipient,
                  contextLimits,
                  maintainContext: async (source, activeIds) => {
                    source();
                    expect(activeIds?.length).toBeGreaterThan(0);
                    return { compacted: false, complete: false };
                  },
                },
              });
              try {
                expect(rechecked?.fragments[0]?.text).toContain('"pending":"context-window"');
                expect(await readPackets()).toEqual(beforeRecheck);
              } finally {
                rechecked?.release();
              }
              const pendingDonor = await fixture.branch("pending-window-donor");
              const pendingOwner = await fixture.claim(pendingDonor);
              const pendingTerminal = await fixture.append(pendingDonor, "pending-window-fact");
              expect(
                await recordConversationKnowledgeTurn({ ...pendingOwner, ...pendingTerminal }),
              ).toBe(true);
              const beforeDeferred = await readPackets();
              const deferred = await prepareReplyConversationKnowledge({
                ...owner,
                originalParticipant: person,
                getRuntimeConfig: () => fixture.cfg,
                retainInHistory: {
                  writeTarget: recipient,
                  contextLimits: { ...contextLimits, maxEvents: 2 },
                  maintainContext: async (source) => {
                    source();
                    return { compacted: false, complete: true };
                  },
                },
              });
              expect(deferred?.fragments[0]?.text).toContain('"reason":"admission-deferred"');
              deferred?.release();
              expect(await readPackets()).toEqual(beforeDeferred);
              const retried = await prepareReplyConversationKnowledge({
                ...owner,
                originalParticipant: person,
                getRuntimeConfig: () => fixture.cfg,
                retainInHistory: {
                  writeTarget: recipient,
                  contextLimits,
                  maintainContext: async (source) => {
                    source();
                  },
                },
              });
              expect(retried?.fragments).toEqual([]);
              retried?.release();
              expect((await readPackets()).length).toBeGreaterThan(beforeDeferred.length);
              expect(JSON.stringify(await readPackets())).toContain("pending-window-fact");
            },
          );
          expect(trace).toEqual([
            "01 root + equal private branches admitted",
            "02 A committed turn becomes one opaque receipt",
            "03 B reads A as neutral data, not a new instruction",
            "04 B commits its own reply and persisted observed frontier",
            "05 newer A exchange advances B without replaying A-one",
            "06 consumed frontier and duplicate report do not replay",
            "07 pending and aborted work never produce completed knowledge",
            "08 foreign-person and group receipts grant no disclosure",
            "09 missing input person and unconfirmed audience fail closed",
            "10 revoke during native report preparation refuses commit",
            "10 replace during native report preparation refuses commit",
            "11 headless root rejects external ingress and contains no dialogue",
            "12 durable catch-up resumes every authorized source without duplicate packets",
          ]);
        } finally {
          await fixture.close();
        }
      },
    );
  });
});
