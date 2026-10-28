import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import type { ConversationKnowledgePacketAdmission } from "../../config/sessions/conversation-knowledge-packets.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  conversationKnowledgeOrigin,
  readConversationKnowledgeReceipt,
  projectConversationKnowledge,
} from "../../config/sessions/conversation-knowledge.js";
import type { TranscriptReportReceiptQuery } from "../../config/sessions/session-accessor.sqlite-transcript-reports.types.js";
import type { TranscriptEvent } from "../../config/sessions/session-accessor.types.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import { SessionMutationAuthorizationChangedError } from "../../gateway/session-mutation-authorization-error.js";
import { SessionMutationFactsUnavailableError } from "../../gateway/session-sharing-incognito.js";
import { createPreparedKnowledgeAdmission } from "./conversation-knowledge-admission.test-support.js";

const source = vi.hoisted(() => ({
  branch: vi.fn(),
  root: vi.fn(),
  preparedRoot: vi.fn(),
  issueRoot: vi.fn(),
  observe: vi.fn(),
  facts: vi.fn(),
  grant: vi.fn(),
  context: vi.fn(),
  contextBatch: vi.fn(),
  retain: vi.fn(),
  anchors: vi.fn(),
  contribution: vi.fn(),
  progress: vi.fn(),
  report: vi.fn(),
  prepareFacts: vi.fn(),
}));
const preparationYield = vi.hoisted(() => vi.fn());
// mock-isolation: Control the native cooperative boundary without scheduling media or timers.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setImmediate: preparationYield,
}));
// Native provenance brands and rebinding have separate root-candidates coverage.
// mock-isolation: Supply unit manifests and silent source gaps without starting transcript workers.
vi.mock("../../config/sessions/conversation-knowledge-store.js", () => ({
  readConversationKnowledgeBranch: source.branch,
  readConversationKnowledgeRoot: source.root,
  readPreparedConversationKnowledgeRoot: source.preparedRoot,
  issuePreparedKnowledgeRootCandidates: source.issueRoot,
  recordConversationKnowledgeTurn: vi.fn(),
}));
// mock-isolation: Observe packet custody without starting native packet storage.
vi.mock("../../config/sessions/conversation-knowledge-packets.js", () => ({
  CONVERSATION_KNOWLEDGE_CONTEXT: "openclaw.conversation-knowledge-context.v1",
  createConversationKnowledgePacketReport: source.report,
  conversationKnowledgeContributionId: source.contribution,
  readConversationKnowledgePacketProgress: source.progress,
  readActiveConversationKnowledgePacketIds: async () => [],
  retainConversationKnowledgePackets: source.retain,
}));
// mock-isolation: Exact native receipt observations replace only storage I/O.
vi.mock("../../config/sessions/session-accessor.sqlite-transcript-reports.js", () => ({
  readSessionTranscriptReportReceipts: source.observe,
}));
// mock-isolation: Supply revocable facts without initializing unrelated Gateway sharing storage.
vi.mock("./conversation-knowledge-authority.js", () => ({
  prepareConversationKnowledgeBranchFacts: source.facts,
  unavailableConversationKnowledge: () => {
    throw new Error("This fixture requires an already-authorized source");
  },
}));
// mock-isolation: This direct preparation test must not initialize the native publication journal.
vi.mock("./conversation-publication.js", () => ({
  captureReplyConversationPublication: () => {
    throw new Error("A source gap must not capture publication");
  },
  recordReplyConversationPublication: () => {
    throw new Error("A source gap must not publish a turn");
  },
}));
// mock-isolation: Existing seed/lifecycle integration coverage owns actual native turn startup.
vi.mock("../../config/sessions/conversation-knowledge-seed.js", () => ({
  ensureConversationKnowledgeSeed: () => {
    throw new Error("Direct source preparation must not seed history");
  },
}));
// mock-isolation: The direct preparation boundary does not consult a live reply registry.
vi.mock("./reply-run-registry.state.js", () => ({
  getReplyOperationSessionReader: () => {
    throw new Error("Direct source preparation must not acquire a reply operation");
  },
}));
// mock-isolation: A source gap must never request broader access.
vi.mock("../../gateway/session-transcript-read-authority.js", () => ({
  prepareTranscriptReadAuthority: source.grant,
}));
// mock-isolation: Mint real opaque admission custody from synthetic native sharing rows.
vi.mock("../../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: source.prepareFacts,
}));
// mock-isolation: Reproduce source gaps without reading a real private transcript.
vi.mock("../../config/sessions/session-transcript-context-read.js", () => ({
  readSessionTranscriptModelContextAsync: source.context,
  readSessionTranscriptModelContextsAsync: source.contextBatch,
}));
// mock-isolation: Prepared ranges use native proof results, never real transcript workers here.
vi.mock("../../config/sessions/session-transcript-anchor-read.js", () => ({
  readSessionTranscriptAnchorsAsync: source.anchors,
}));
// mock-isolation: Synthetic storage uses full fixed native version facts, never a real database.
vi.mock("../../config/sessions/session-transcript-hydration.js", () => ({
  prepareSessionTranscriptHydration: () => ({
    readMaintenance: async () => ({
      kind: "transcript-maintenance",
      version: { generation: "original", rawSeq: 2, updatedAt: 1 },
    }),
  }),
}));

import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";

beforeEach(() => {
  for (const mock of Object.values(source)) {
    mock.mockReset();
  }
  source.contribution.mockReturnValue("synthetic-contribution");
  source.progress.mockImplementation(async () => new Map());
  source.issueRoot.mockImplementation(() => Object.freeze({ byteLength: 128 }));
  source.observe.mockImplementation(
    async (_target, queries: readonly TranscriptReportReceiptQuery[]) => ({
      ok: true,
      value: queries.map((query) => ({ ...query, status: "missing" })),
    }),
  );
  source.report.mockImplementation(
    ({
      text,
      receipt,
      offset,
    }: {
      text: string;
      receipt: { through: { entryId: string } };
      offset: number;
    }) => ({
      customType: "synthetic-knowledge-packet",
      content: text,
      display: false,
      details: { packetId: `${receipt.through.entryId}:${offset}` },
    }),
  );
  preparationYield.mockReset().mockResolvedValue(undefined);
});

function setRootReports(events: TranscriptEvent[]) {
  source.root.mockResolvedValue(events);
  source.preparedRoot.mockResolvedValue(events);
}

describe("related-history source custody without model status", () => {
  it.each([
    "admission",
    "unavailable",
    "prepared-unavailable",
    "prepared-anchor-unavailable",
    "removed-cursor",
    "preparation",
    "saturated",
  ] as const)(
    "resumes ordered contributions without starving later readable sources (%s)",
    async (kind) => {
      const admission =
        kind === "admission" ||
        kind === "unavailable" ||
        kind.startsWith("prepared-") ||
        kind === "removed-cursor";
      const participant = { type: "profile" as const, id: "example-person" };
      const audienceIdentity = conversationKnowledgeParticipantIdentity(participant);
      const branch = {
        agentId: "example",
        sessionKey: "agent:example:recipient",
        sessionId: "recipient",
        lifecycleRevision: "original",
        storePath: "/synthetic/agent.sqlite",
        root: {
          sessionKey: "agent:example:root",
          sessionId: "root",
          lifecycleRevision: "original",
        },
      };
      const receipts = ["large", "small"].map((id) => {
        const donor = {
          agentId: branch.agentId,
          sessionKey: `agent:example:${id}`,
          sessionId: id,
          lifecycleRevision: "original",
        };
        const receipt = readConversationKnowledgeReceipt({
          version: 1 as const,
          sourceMode: "branches" as const,
          source: donor,
          origin: conversationKnowledgeOrigin(donor),
          runId: `${id}-run`,
          through: {
            ...donor,
            storePath: branch.storePath,
            generation: "original",
            entryId: `${id}-answer`,
            rawSeq: 2,
            activeMessagePosition: 1,
            effectiveParentId: `${id}-question`,
          },
        });
        if (!receipt) {
          throw new Error("Synthetic fairness receipt is invalid");
        }
        return receipt;
      });
      source.branch.mockResolvedValue(branch);
      setRootReports(
        receipts.map((details) => ({
          type: "custom_message",
          customType: CONVERSATION_KNOWLEDGE_REPORT,
          details,
        })),
      );
      source.contribution.mockImplementation((receipt) => receipt.through.entryId);
      source.facts.mockImplementation(async () => ({
        audience: "private-direct",
        audienceIdentity,
        assertCurrent() {},
        release() {},
      }));
      const admissions = new Map<
        string,
        Awaited<ReturnType<typeof createPreparedKnowledgeAdmission>>
      >();
      for (const receipt of receipts) {
        admissions.set(
          receipt.source.sessionId,
          await createPreparedKnowledgeAdmission({
            branch,
            donor: receipt.source,
            participant,
            installFacts: (prepare) => source.prepareFacts.mockImplementation(prepare),
          }),
        );
      }
      source.grant.mockImplementation(async ({ sources }) => ({
        audience: "private-direct",
        audienceIdentity,
        sources: sources.map((donor: (typeof receipts)[number]["source"]) => ({
          ...donor,
          canonicalKey: donor.sessionKey,
          storePath: branch.storePath,
        })),
        assertCurrent() {},
        release() {},
        prepareAdmission() {
          const prepared = admissions.get(sources[0].sessionId);
          if (!prepared) {
            throw new Error("Missing synthetic donor admission");
          }
          return prepared;
        },
      }));
      source.anchors.mockImplementation(async (target, _selection, _signal, consume) => {
        if (kind === "prepared-anchor-unavailable" && target.sessionId === "large") {
          await Promise.resolve();
          throw new SessionMutationFactsUnavailableError();
        }
        consume({ contextValidated: true });
      });
      const progress = new Map<string, { complete: boolean; nextOffset: number }>();
      source.progress.mockImplementation(async () => new Map(progress));
      source.retain.mockImplementation(
        async ({ packets }: { packets: ConversationKnowledgePacketAdmission[] }) => {
          for (const packet of packets) {
            progress.set(packet.receipt.through.entryId, {
              complete: packet.complete,
              nextOffset: packet.nextOffset,
            });
          }
          return {
            accepted: packets.length,
            appended: packets.length,
            deferred: false,
            packetIds: packets.map(
              (packet) => `${packet.receipt.through.entryId}:${packet.offset}`,
            ),
          };
        },
      );
      source.context.mockImplementation(async (target, consume) => {
        const receipt = receipts.find(
          (candidate) => candidate.source.sessionId === target.sessionId,
        )!;
        return consume({
          version: { generation: "original", rawSeq: 2, updatedAt: 1 },
          events: [
            {
              type: "message",
              id: `${receipt.source.sessionId}-question`,
              message: {
                role: "user",
                content: "Synthetic source observation. ".repeat(receipt === receipts[0] ? 500 : 1),
              },
            },
            {
              type: "message",
              id: receipt.through.entryId,
              message: {
                role: "assistant",
                content: "Understood.",
                stopReason: "stop",
                __openclaw: { runId: receipt.runId },
              },
            },
          ],
        });
      });
      const cache = createConversationKnowledgeSourceCache(
        kind === "saturated" ? 4_500 : undefined,
      );
      const stage = vi.spyOn(cache, "stage");
      for (const receipt of admission ? receipts : []) {
        const preparedAdmission = admissions.get(receipt.source.sessionId)!;
        expect(
          cache.retainAdmission(
            receipt.through.entryId,
            { ...receipt.source, storePath: receipt.through.storePath },
            preparedAdmission,
          ),
        ).toBe(true);
        const large = receipt === receipts[0];
        cache.stage(receipt.through.entryId, 0, {
          part: {
            origin: receipt.origin,
            text: `${receipt.source.sessionId} observation`,
            complete: !large,
            nextOffset: large ? 10 : undefined,
            frontier: large
              ? undefined
              : {
                  origin: receipt.origin,
                  generation: receipt.through.generation,
                  throughRawSeq: receipt.through.rawSeq,
                  throughEntryId: receipt.through.entryId,
                },
          },
          version: { generation: "original", rawSeq: 2, updatedAt: 1 },
          through: receipt.through,
        });
        if (large) {
          cache.stage(receipt.through.entryId, 10, {
            part: {
              origin: receipt.origin,
              text: "Further large observation",
              complete: true,
              nextOffset: 20,
              frontier: {
                origin: receipt.origin,
                generation: receipt.through.generation,
                throughRawSeq: receipt.through.rawSeq,
                throughEntryId: receipt.through.entryId,
              },
            },
            version: { generation: "original", rawSeq: 2, updatedAt: 1 },
            through: receipt.through,
          });
        }
      }
      if (admission) {
        cache.setPreparedRoot(source.issueRoot());
      }
      const reader: SessionEntryCohortReader = {
        database: { agentId: branch.agentId, path: branch.storePath, env: {} },
        logicalAgentId: branch.agentId,
        sessionKey: branch.sessionKey,
        storePaths: [branch.storePath],
        assertCurrent() {},
        async withRead() {
          throw new Error("Mock packet admission owns this boundary");
        },
      };
      const common = {
        reader,
        sessionId: branch.sessionId,
        assertCurrent() {},
        originalParticipant: participant,
        getRuntimeConfig: () => ({
          agents: { entries: { example: { conversationMode: "branches" as const } } },
        }),
        readyOnly: admission,
        sourceCache: cache,
        ...(admission
          ? {
              packetBudget: 1,
              retainInHistory: {
                writeTarget: branch,
                maintainContext: async () => ({
                  compacted: false,
                  complete: true,
                  canAdmitPending: true,
                }),
              },
            }
          : { preparationOnly: true, sourceBudget: 8 }),
      };
      if (kind === "prepared-unavailable") {
        source.grant.mockRejectedValueOnce(new SessionMutationFactsUnavailableError());
      }
      const first = await prepareReplyConversationKnowledge(common);
      if (kind.startsWith("prepared-")) {
        try {
          expect(source.grant).toHaveBeenCalledTimes(2);
          expect(
            source.grant.mock.calls.every(([request]) => request.preparedAdmission !== undefined),
          ).toBe(true);
          expect(
            source.retain.mock.calls.flatMap(([call]) =>
              call.packets.map(
                (packet: ConversationKnowledgePacketAdmission) => packet.receipt.through.entryId,
              ),
            ),
          ).toEqual(["small-answer"]);
          expect(progress.has("large-answer")).toBe(false);
          expect(progress.get("small-answer")?.complete).toBe(true);
          expect(source.context).not.toHaveBeenCalled();
          if (kind === "prepared-anchor-unavailable") {
            expect(source.anchors.mock.calls.map(([target]) => target.sessionId)).toEqual([
              "large",
              "small",
            ]);
            expect(first?.pendingPackets).toBe(true);
          }
          expect(() => first?.assertCurrent()).not.toThrow();
        } finally {
          first?.release();
        }
        return;
      }
      if (!admission) {
        try {
          expect(source.retain).not.toHaveBeenCalled();
          expect(stage.mock.calls.slice(0, 2).map(([id]) => id)).toEqual([
            "large-answer",
            "large-answer",
          ]);
          if (kind === "saturated") {
            expect(stage.mock.results.map((result) => result.value)).toEqual([true, false]);
            expect(first?.preparationSaturated).toBe(true);
            expect(first?.nextSourceCursor).toBe("large-answer");
          } else {
            expect(cache.peek("small-answer", 0)).toBeDefined();
            const large = stage.mock.calls.slice(0, -1);
            expect(large.length).toBeGreaterThan(2);
            expect(large.every(([id]) => id === "large-answer")).toBe(true);
            expect(large.at(-1)?.[2].part.complete).toBe(true);
            expect(stage.mock.calls.at(-1)?.[0]).toBe("small-answer");
            for (let index = 1; index < large.length; index++) {
              expect(large[index]![1]).toBe(large[index - 1]![2].part.nextOffset);
            }
            expect(first?.preparationSaturated).toBe(false);
          }
        } finally {
          first?.release();
        }
        return;
      }
      try {
        expect(first?.pendingPackets).toBe(true);
        expect(first?.nextSourceCursor).toBe("large-answer");
        expect(
          source.retain.mock.calls.flatMap(([call]) =>
            call.packets.map(
              (packet: ConversationKnowledgePacketAdmission) => packet.receipt.through.entryId,
            ),
          ),
        ).toEqual(["large-answer"]);
      } finally {
        first?.release();
      }
      if (kind === "unavailable") {
        source.grant.mockRejectedValueOnce(
          new SessionMutationAuthorizationChangedError({
            code: "FORBIDDEN",
            message: "Original source is no longer readable",
          }),
        );
      } else if (kind === "removed-cursor") {
        setRootReports([
          {
            type: "custom_message",
            customType: CONVERSATION_KNOWLEDGE_REPORT,
            details: receipts[1],
          },
        ]);
      }
      const second = await prepareReplyConversationKnowledge({
        ...common,
        sourceCursor: first?.nextSourceCursor,
      });
      try {
        if (kind !== "admission") {
          expect(
            source.retain.mock.calls.flatMap(([call]) =>
              call.packets.map(
                (packet: ConversationKnowledgePacketAdmission) => packet.receipt.through.entryId,
              ),
            ),
          ).toEqual(["large-answer", "small-answer"]);
          expect(second?.nextSourceCursor).toBeUndefined();
          expect(second?.pendingPackets).toBe(false);
          expect(source.context).not.toHaveBeenCalled();
          return;
        }
        expect(
          source.retain.mock.calls.flatMap(([call]) =>
            call.packets.map(
              (packet: ConversationKnowledgePacketAdmission) => packet.receipt.through.entryId,
            ),
          ),
        ).toEqual(["large-answer", "large-answer"]);
        expect(second?.nextSourceCursor).toBe("small-answer");
        expect(source.context).not.toHaveBeenCalled();
      } finally {
        second?.release();
      }
      // An earlier source can retire between quanta. Resume by contribution ID,
      // not the old index, without skipping the now-first remaining source.
      setRootReports([
        {
          type: "custom_message",
          customType: CONVERSATION_KNOWLEDGE_REPORT,
          details: receipts[1],
        },
      ]);
      const third = await prepareReplyConversationKnowledge({
        ...common,
        sourceCursor: second?.nextSourceCursor,
      });
      try {
        expect(
          source.retain.mock.calls.flatMap(([call]) =>
            call.packets.map(
              (packet: ConversationKnowledgePacketAdmission) => packet.receipt.through.entryId,
            ),
          ),
        ).toEqual(["large-answer", "large-answer", "small-answer"]);
        expect(third?.nextSourceCursor).toBeUndefined();
        expect(third?.pendingPackets).toBe(false);
        expect(source.context).not.toHaveBeenCalled();
      } finally {
        third?.release();
      }
    },
  );
  it.each([
    "missing-range",
    "unverified-exchange",
    "admission-refused",
    "admitted",
    "prepare-only",
    "prepare-yield",
    "prepare-yield-revoked",
    "prepare-yield-canceled",
    "ready-empty",
    "ready-admitted",
    "ready-historical",
    "ready-stale",
    "capacity-deferred",
    "source-changed",
    "snapshot-observed",
    "lookahead-revoked",
    "queued-lookahead-revoked",
    "hydration-facts-pending",
    "hydration-facts-refused",
    "admission-facts-pending",
    "admission-facts-refused",
  ] as const)("retains source authority only for actual imported data (%s)", async (kind) => {
    const participant = { type: "profile" as const, id: "example-person" };
    const branch = {
      agentId: "example",
      sessionKey: "agent:example:recipient",
      sessionId: "recipient",
      lifecycleRevision: "original",
      storePath: "/synthetic/agent.sqlite",
      root: {
        sessionKey: "agent:example:root",
        sessionId: "root",
        lifecycleRevision: "original",
      },
    };
    const donor = {
      agentId: branch.agentId,
      sessionKey: "agent:example:donor",
      sessionId: "donor",
      lifecycleRevision: "original",
    };
    const audience = conversationKnowledgeParticipantIdentity(participant);
    const release = vi.fn();
    const targetRelease = vi.fn();
    let readable = true;
    let donorFactsPending = false;
    const factsUnavailable = new SessionMutationFactsUnavailableError();
    const transientFacts = kind.includes("-facts-");
    const cancellation = new AbortController();
    const lookaheadRevoked = kind === "lookahead-revoked" || kind === "queued-lookahead-revoked";
    const assertSource = () => {
      if (donorFactsPending) {
        throw factsUnavailable;
      }
      if (!readable) {
        if (kind === "queued-lookahead-revoked") {
          throw new Error("Transcript source is no longer readable");
        }
        if (lookaheadRevoked) {
          throw new SessionTranscriptReadFenceError("Synthetic lookahead grant revoked");
        }
        throw new Error("Diagnostic source revoked");
      }
    };
    source.branch.mockResolvedValue(branch);
    source.facts.mockResolvedValue({
      audience: "private-direct",
      audienceIdentity: audience,
      assertCurrent() {},
      release: targetRelease,
    });
    const preparedAdmission = await createPreparedKnowledgeAdmission({
      branch,
      donor,
      participant,
      installFacts: (prepare) => source.prepareFacts.mockImplementation(prepare),
    });
    source.grant.mockResolvedValue({
      audience: "private-direct",
      audienceIdentity: audience,
      sources: [{ ...donor, canonicalKey: donor.sessionKey, storePath: branch.storePath }],
      assertCurrent: assertSource,
      release,
      prepareAdmission: () => preparedAdmission,
    });
    setRootReports([
      {
        type: "custom_message",
        customType: CONVERSATION_KNOWLEDGE_REPORT,
        details: {
          version: 1,
          sourceMode: "branches",
          source: donor,
          origin: conversationKnowledgeOrigin(donor),
          runId: "donor-run",
          through: {
            ...donor,
            storePath: branch.storePath,
            generation: "original",
            entryId: "answer",
            rawSeq: 2,
            activeMessagePosition: 1,
            effectiveParentId: "question",
          },
        },
      },
    ]);
    if (lookaheadRevoked) {
      const reports = await source.root();
      const receipt = readConversationKnowledgeReceipt(reports[0].details)!;
      const labels = kind === "queued-lookahead-revoked" ? ["next", "third", "fourth"] : ["next"];
      const lookaheadReports = [...reports];
      for (const [index, label] of labels.entries()) {
        lookaheadReports.push({
          ...reports[0],
          details: {
            ...receipt,
            runId: `donor-${label}-run`,
            through: {
              ...receipt.through,
              entryId: `${label}-answer`,
              rawSeq: 4 + index * 2,
              activeMessagePosition: 3 + index * 2,
              effectiveParentId: `${label}-question`,
            },
          },
        });
      }
      setRootReports(lookaheadReports);
      source.contribution.mockImplementation((reference) => reference.through.entryId);
      source.grant.mockImplementation(async () => {
        assertSource();
        return {
          audience: "private-direct",
          audienceIdentity: audience,
          sources: [{ ...donor, canonicalKey: donor.sessionKey, storePath: branch.storePath }],
          assertCurrent: assertSource,
          release,
          prepareAdmission: () => preparedAdmission,
        };
      });
      // Both ranges share one original source. Revoking its look-ahead grant
      // during hydration must release both held claims, not poison finalization.
      source.contextBatch.mockImplementation(async (_target, ranges, consume) => {
        if (kind === "queued-lookahead-revoked" && source.contextBatch.mock.calls.length === 1) {
          return consume(
            ranges.map(
              ({ through }: { through: { entryId: string; effectiveParentId: string } }) => ({
                ok: true,
                context: {
                  version: { generation: "original", rawSeq: 8, updatedAt: 1 },
                  events: [
                    {
                      type: "message",
                      id: through.effectiveParentId,
                      message: { role: "user", content: "A queued synthetic observation." },
                    },
                    {
                      type: "message",
                      id: through.entryId,
                      message: {
                        role: "assistant",
                        content: "Understood.",
                        stopReason: "stop",
                        __openclaw: {
                          runId: through.entryId === "answer" ? "donor-run" : "donor-next-run",
                        },
                      },
                    },
                  ],
                },
              }),
            ),
          );
        }
        if (kind === "queued-lookahead-revoked") {
          expect(source.report).toHaveBeenCalledTimes(2);
          expect(source.retain).not.toHaveBeenCalled();
        }
        readable = false;
        return consume([]);
      });
    }
    if (kind === "snapshot-observed") {
      const reports = await source.root();
      const receipt = readConversationKnowledgeReceipt(reports[0].details)!;
      setRootReports([
        ...reports,
        {
          type: "custom_message",
          customType: CONVERSATION_KNOWLEDGE_REPORT,
          details: {
            ...receipt,
            source: branch,
            origin: conversationKnowledgeOrigin(branch),
            runId: "recipient-run",
            through: {
              ...receipt.through,
              ...branch,
              entryId: "recipient-answer",
            },
            observed: [
              {
                origin: receipt.origin,
                generation: receipt.through.generation,
                throughRawSeq: receipt.through.rawSeq,
                throughEntryId: receipt.through.entryId,
              },
            ],
          },
        },
      ]);
    }
    if (kind === "missing-range") {
      source.context.mockRejectedValue(new SessionTranscriptReadFenceError("Missing range"));
    } else if (kind === "unverified-exchange") {
      source.context.mockImplementation(async (_target, consume) => consume({ events: [] }));
    } else {
      const accepted = kind === "admitted" || kind === "ready-admitted";
      source.retain.mockResolvedValue({
        accepted: accepted ? 1 : 0,
        appended: accepted ? 1 : 0,
        deferred: !accepted,
        packetIds: accepted ? ["saved-packet"] : [],
      });
      if (kind === "source-changed") {
        source.retain.mockRejectedValue(new SessionTranscriptReadFenceError("Source changed"));
      }
      source.context.mockImplementation(async (_target, consume) =>
        consume({
          version: { generation: "original", rawSeq: 2, updatedAt: 1 },
          events: [
            {
              type: "message",
              id: "question",
              message: {
                role: "user",
                content: "The synthetic fact is blue.".repeat(
                  kind.startsWith("prepare-yield") ? 400 : 1,
                ),
              },
            },
            {
              type: "message",
              id: "answer",
              message: {
                role: "assistant",
                content: "Blue, understood.",
                stopReason: "stop",
                __openclaw: { runId: "donor-run" },
              },
            },
          ],
        }),
      );
    }
    const reader: SessionEntryCohortReader = {
      database: { agentId: branch.agentId, path: branch.storePath, env: {} },
      logicalAgentId: branch.agentId,
      sessionKey: branch.sessionKey,
      storePaths: [branch.storePath],
      assertCurrent() {},
      async withRead() {
        throw new Error("A source gap must never write a packet");
      },
    };
    const readyOnly =
      kind.startsWith("ready-") || kind === "capacity-deferred" || kind === "snapshot-observed";
    const cache = createConversationKnowledgeSourceCache();
    const stage = vi.spyOn(cache, "stage");
    if (kind.startsWith("prepare-yield")) {
      preparationYield.mockImplementationOnce(async (_value, options) => {
        expect(options.signal).toBe(cancellation.signal);
        expect(stage).toHaveBeenCalledOnce();
        if (kind === "prepare-yield-revoked") {
          readable = false;
        } else if (kind === "prepare-yield-canceled") {
          cancellation.abort(new Error("Synthetic preparation canceled"));
        }
      });
    }
    if (readyOnly && kind !== "ready-empty") {
      const reports = await source.root();
      const receipt = readConversationKnowledgeReceipt(reports[0].details)!;
      const context = await source.context(undefined, (value: unknown) => value);
      const part = projectConversationKnowledge(
        receipt,
        context.events,
        undefined,
        "private-direct",
      )!;
      expect(
        cache.stage("synthetic-contribution", 0, {
          part,
          version: context.version,
          through: receipt.through,
        }),
      ).toBe(true);
      expect(
        cache.retainAdmission(
          "synthetic-contribution",
          { ...receipt.source, storePath: receipt.through.storePath },
          preparedAdmission,
        ),
      ).toBe(true);
      source.context.mockClear();
      cache.setPreparedRoot(source.issueRoot());
    }
    if (kind === "ready-historical") {
      source.observe.mockImplementation(
        async (_target, queries: readonly TranscriptReportReceiptQuery[]) => ({
          ok: true,
          value: queries.map((query) => ({
            ...query,
            status: "historical",
            eventId: "historical-native-packet",
            report: {
              customType: query.customType,
              content: "An observation already retained by native compaction.",
              display: false,
              details: { packetId: query.receipt.value },
            },
          })),
        }),
      );
    }
    source.root.mockClear();
    source.anchors.mockImplementation(async (_target, _selection, _signal, consume) => {
      if (kind === "ready-stale") {
        throw new SessionTranscriptReadFenceError("Stale prepared range");
      }
      consume({ contextValidated: true });
    });
    const packets: unknown[] = [];
    if (transientFacts) {
      const operation = kind.startsWith("hydration-") ? source.context : source.retain;
      operation.mockImplementationOnce(async () => {
        donorFactsPending = true;
        throw kind.endsWith("-pending")
          ? factsUnavailable
          : new SessionTranscriptReadFenceError("Synthetic pending donor publication");
      });
      source.retain.mockResolvedValue({
        accepted: 1,
        appended: 1,
        deferred: false,
        packetIds: ["saved-packet"],
      });
    }
    const prepare = () =>
      prepareReplyConversationKnowledge({
        reader,
        sessionId: branch.sessionId,
        assertCurrent() {},
        originalParticipant: participant,
        signal: cancellation.signal,
        getRuntimeConfig: () => ({
          agents: { entries: { example: { conversationMode: "branches" } } },
        }),
        ...(kind.startsWith("prepare-")
          ? { preparationOnly: true, sourceCache: cache }
          : kind !== "snapshot-observed"
            ? {
                retainInHistory: {
                  writeTarget: branch,
                  maintainContext: async () => ({
                    compacted: false,
                    complete: true,
                    canAdmitPending: true,
                  }),
                },
              }
            : {}),
        ...(readyOnly
          ? {
              readyOnly: true,
              sourceCache: cache,
              canAdmitPacket: () => kind !== "capacity-deferred",
              onPacket: (packet: unknown) => packets.push(packet),
            }
          : {}),
        ...(lookaheadRevoked || transientFacts
          ? { sourceCache: cache, onPacket: (packet: unknown) => packets.push(packet) }
          : {}),
      });
    const preparation = prepare();
    if (transientFacts) {
      await expect(preparation).rejects.toBe(factsUnavailable);
      expect(release).toHaveBeenCalledOnce();
      expect(targetRelease).toHaveBeenCalledOnce();
      expect(packets).toEqual([]);
      expect(source.retain).toHaveBeenCalledTimes(kind.startsWith("hydration-") ? 0 : 1);
      // A fresh preparation reacquires facts after the native publication settles.
      donorFactsPending = false;
      source.facts.mockResolvedValueOnce({
        audience: "private-direct",
        audienceIdentity: audience,
        assertCurrent() {},
        release: targetRelease,
      });
      const recovered = await prepare();
      try {
        expect(recovered?.pendingPackets).toBe(false);
        expect(source.retain).toHaveBeenCalledTimes(kind.startsWith("hydration-") ? 1 : 2);
        expect(packets).toHaveLength(1);
        expect(() => recovered?.assertCurrent()).not.toThrow();
      } finally {
        recovered?.release();
      }
      expect(release).toHaveBeenCalledTimes(2);
      expect(targetRelease).toHaveBeenCalledTimes(2);
      return;
    }
    if (kind === "prepare-yield-revoked" || kind === "prepare-yield-canceled") {
      await expect(preparation).rejects.toThrow(
        kind === "prepare-yield-revoked"
          ? "Diagnostic source revoked"
          : "Synthetic preparation canceled",
      );
      expect(preparationYield).toHaveBeenCalledOnce();
      expect(stage).toHaveBeenCalledOnce();
      expect(source.retain).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(targetRelease).toHaveBeenCalledOnce();
      return;
    }
    const prepared = await preparation;
    if (kind === "ready-empty") {
      expect(prepared).toBeUndefined();
      for (const operation of [
        source.branch,
        source.facts,
        source.root,
        source.preparedRoot,
        source.observe,
        source.grant,
        source.context,
        source.contextBatch,
        source.anchors,
        source.retain,
        release,
        targetRelease,
      ]) {
        expect(operation).not.toHaveBeenCalled();
      }
      expect(packets).toEqual([]);
      return;
    }
    try {
      expect(prepared?.fragments).toEqual([]);
      if (kind === "admitted" || kind === "ready-historical" || kind === "snapshot-observed") {
        expect(release).not.toHaveBeenCalled();
      } else {
        expect(release).toHaveBeenCalledTimes(
          lookaheadRevoked ? (kind === "queued-lookahead-revoked" ? 4 : 2) : 1,
        );
      }
      if (
        [
          "missing-range",
          "unverified-exchange",
          "prepare-only",
          "prepare-yield",
          "ready-historical",
          "ready-stale",
          "capacity-deferred",
          "snapshot-observed",
          "lookahead-revoked",
          "queued-lookahead-revoked",
        ].includes(kind)
      ) {
        expect(source.retain).not.toHaveBeenCalled();
      } else {
        expect(source.retain).toHaveBeenCalledOnce();
      }
      if (readyOnly) {
        expect(source.root).not.toHaveBeenCalled();
        expect(source.context).not.toHaveBeenCalled();
        expect(source.contextBatch).not.toHaveBeenCalled();
        expect(packets).toHaveLength(kind === "ready-admitted" ? 1 : 0);
      }
      if (kind === "snapshot-observed") {
        expect(source.grant).not.toHaveBeenCalled();
        expect(source.anchors).not.toHaveBeenCalled();
        expect(cache.peek("synthetic-contribution", 0)).toBeDefined();
      }
      if (kind === "ready-historical") {
        expect(source.grant).not.toHaveBeenCalled();
        expect(source.anchors).not.toHaveBeenCalled();
        expect(cache.peek("synthetic-contribution", 0)).toBeUndefined();
      }
      if (kind === "prepare-only") {
        expect(cache.peek("synthetic-contribution", 0)).toBeDefined();
      }
      if (kind === "prepare-yield") {
        expect(stage.mock.calls.length).toBeGreaterThan(2);
        expect(stage.mock.calls.at(-1)?.[2].part.complete).toBe(true);
        expect(preparationYield).toHaveBeenCalledTimes(stage.mock.calls.length - 1);
        for (let index = 1; index < stage.mock.calls.length; index++) {
          expect(stage.mock.calls[index]![1]).toBe(stage.mock.calls[index - 1]![2].part.nextOffset);
        }
      }
      if (kind === "ready-stale") {
        expect(cache.peek("synthetic-contribution", 0)).toBeUndefined();
      }
      if (kind === "capacity-deferred" || kind === "ready-stale" || kind === "source-changed") {
        expect(prepared?.pendingPackets).toBe(true);
      }
      if (kind === "lookahead-revoked") {
        expect(source.contextBatch).toHaveBeenCalledOnce();
        expect(source.context).not.toHaveBeenCalled();
        expect(source.grant).toHaveBeenCalledTimes(3);
        expect(() => prepared?.assertCurrent()).not.toThrow();
      }
      if (kind === "queued-lookahead-revoked") {
        expect(source.contextBatch).toHaveBeenCalledTimes(2);
        expect(source.context).not.toHaveBeenCalled();
        expect(source.grant).toHaveBeenCalledTimes(4);
        expect(source.report).toHaveBeenCalledTimes(2);
        expect(packets).toEqual([]);
        expect(prepared?.pendingPackets).toBe(true);
        expect(prepared?.nextSourceCursor).toBe("answer");
        expect(() => prepared?.assertCurrent()).not.toThrow();
      }
      readable = false;
      if (kind === "admitted") {
        expect(() => prepared?.assertCurrent()).toThrow("Diagnostic source revoked");
      } else {
        expect(() => prepared?.assertCurrent()).not.toThrow();
      }
    } finally {
      prepared?.release();
    }
    expect(release).toHaveBeenCalledTimes(
      kind === "ready-historical" || kind === "snapshot-observed"
        ? 0
        : lookaheadRevoked
          ? kind === "queued-lookahead-revoked"
            ? 4
            : 2
          : 1,
    );
    expect(targetRelease).toHaveBeenCalledOnce();
  });
});
