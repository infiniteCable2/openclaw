import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_KNOWLEDGE_SEED,
  ensureConversationKnowledgeSeed,
} from "./conversation-knowledge-seed.js";
import { ConversationKnowledgeSourceCapacityError } from "./conversation-knowledge-store.js";
import {
  conversationKnowledgeOrigin,
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_KNOWLEDGE_SOURCE_LIMITS,
  CONVERSATION_UTTERANCE_REPORT,
} from "./conversation-knowledge.js";
import type { TranscriptReport } from "./session-accessor.sqlite-transcript-reports.types.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { SessionEntryCohortResult } from "./session-entry-read.types.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";

const mocks = vi.hoisted(() => ({
  branch: vi.fn(),
  reports: vi.fn(),
  raw: vi.fn(),
  delta: vi.fn(),
  metadata: vi.fn(),
  metadataCurrent: vi.fn(),
  context: vi.fn(),
  record: vi.fn(),
  voice: vi.fn(),
  anchor: vi.fn(),
  append: vi.fn(),
}));
// mock-isolation: Exercise the bounded seed protocol without databases, workers or model execution.
vi.mock("./conversation-knowledge-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./conversation-knowledge-store.js")>()),
  readConversationKnowledgeBranch: mocks.branch,
  recordConversationKnowledgeTurn: mocks.record,
  recordConversationUtteranceObservation: mocks.voice,
}));
// mock-isolation: Supply opaque root receipts without opening a history worker.
vi.mock("./conversation-knowledge-history.js", () => ({
  readConversationKnowledgeReports: mocks.reports,
}));
// mock-isolation: Drive finite native page outcomes without retaining database resources.
vi.mock("./session-transcript-delta-read.js", () => ({
  withSessionTranscriptDeltaReader: mocks.delta,
}));
// mock-isolation: Supply native version facts without opening another worker owner.
vi.mock("./session-transcript-hydration.js", () => ({
  prepareSessionTranscriptHydration: () => ({
    readMaintenance: mocks.metadata,
    assertCurrent: mocks.metadataCurrent,
  }),
}));
// mock-isolation: Reject accidental whole-history hydration in this paginated protocol.
vi.mock("./session-transcript-context-read.js", () => ({
  readSessionTranscriptModelContextAsync: mocks.context,
}));
// mock-isolation: Keep native background projection jobs outside this protocol fixture.
vi.mock("./session-transcript-reconcile.js", () => ({
  waitForSessionTranscriptProjection: async () => {},
}));
// mock-isolation: Supply the exact voice anchor without starting a transcript reader worker.
vi.mock("./session-transcript-anchor-read.js", () => ({
  readActiveTranscriptEntryAnchorAsync: mocks.anchor,
}));
// mock-isolation: Observe prepared completion authority without committing a database write.
vi.mock("./session-accessor.sqlite-transcript-reports.js", () => ({
  appendSessionTranscriptReport: mocks.append,
}));

const branch = {
  agentId: "example",
  sessionKey: "agent:example:main",
  sessionId: "native-original",
  lifecycleRevision: "native-life",
  storePath: "/synthetic/sessions.sqlite",
  root: {
    sessionKey: "agent:example:conversation-root",
    sessionId: "root",
    lifecycleRevision: "root-life",
  },
};
const sourceEntry = {
  sessionId: branch.sessionId,
  lifecycleRevision: branch.lifecycleRevision,
  updatedAt: 1,
  conversationTopology: {
    version: 1 as const,
    role: "branch" as const,
    rootSessionKey: branch.root.sessionKey,
    rootSessionId: branch.root.sessionId,
    rootSessionLifecycleRevision: branch.root.lifecycleRevision,
  },
};
const rootEntry = {
  sessionId: branch.root.sessionId,
  lifecycleRevision: branch.root.lifecycleRevision,
  updatedAt: 1,
  conversationTopology: { version: 1 as const, role: "root" as const },
  createdVia: "internal" as const,
  createdActor: { type: "system" as const, id: "conversation-root" },
  visibility: "draft" as const,
  delivery: { kind: "none" as const },
};
const version = { generation: "original-generation", rawSeq: 6, updatedAt: 1 };
const anchor = {
  ...branch,
  generation: version.generation,
  entryId: "voice",
  rawSeq: 5,
  activeMessagePosition: 3,
  effectiveParentId: "answer",
};
const assertCurrent: SessionSourceAssertion = Object.assign(() => {}, {
  prepareSessionSource: async () => ({ assertCurrent: () => {}, checks: [] }),
});
let projectRead: (facts: SessionEntryCohortResult) => SessionEntryCohortResult;
const reader: SessionEntryCohortReader = {
  database: { agentId: branch.agentId, path: branch.storePath, env: {} },
  sessionKey: branch.sessionKey,
  logicalAgentId: branch.agentId,
  storePaths: [branch.storePath],
  assertCurrent: () => {},
  async withRead(request, assertSource, consume) {
    assertSource();
    const facts = {
      kind: "session-exact-entries" as const,
      source: {
        agentId: branch.agentId,
        path: branch.storePath,
        databaseIdentity: "synthetic-identity",
      },
      databaseIdentity: {
        identity: "synthetic-identity",
        incarnation: "original",
        filename: branch.storePath,
      },
      entries: [
        { sessionKey: branch.sessionKey, entry: sourceEntry },
        { sessionKey: branch.root.sessionKey, entry: rootEntry },
      ].filter((entry) => request.sessionKeys.includes(entry.sessionKey)),
      lifecycleTimestamps: {},
      members: {},
    } satisfies SessionEntryCohortResult;
    return consume(projectRead(facts), assertSource);
  },
};
const params = { reader, sessionId: branch.sessionId, assertCurrent };
const terminal = {
  seq: 3,
  event: {
    type: "message",
    id: "answer",
    message: {
      role: "assistant",
      content: "A completed answer.",
      stopReason: "stop",
      idempotencyKey: "saved-answer",
      __openclaw: { runId: "saved-run" },
    },
  },
};
const voice = {
  seq: 5,
  event: {
    type: "message",
    id: "voice",
    message: {
      role: "user",
      content: "A committed utterance.",
      provenance: { kind: "realtime_voice", sourceChannel: "talk" },
    },
  },
};
let savedReports: Array<Record<string, unknown>>;
let sourceVersion: SessionTranscriptContextVersion;

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  projectRead = (facts) => facts;
  savedReports = [];
  sourceVersion = version;
  mocks.branch.mockResolvedValue(branch);
  mocks.reports.mockImplementation(async ({ customTypes }: { customTypes: string[] }) =>
    savedReports.filter((report) => customTypes.includes(String(report.customType))),
  );
  mocks.metadata.mockImplementation(async () => ({ version: sourceVersion }));
  mocks.raw.mockResolvedValue({
    kind: "page",
    events: [terminal, voice],
    cursor: "done",
    hasMore: false,
  });
  mocks.delta.mockImplementation(async (_target, consume) => consume({ raw: mocks.raw }));
  mocks.context.mockImplementation(() => {
    throw new Error("Seed must not hydrate the whole model context");
  });
  mocks.record.mockResolvedValue(true);
  mocks.voice.mockResolvedValue(true);
  mocks.anchor.mockResolvedValue(anchor);
  mocks.append.mockImplementation(
    async (_target, report: TranscriptReport, options: { source: SessionSourceAssertion }) => {
      const prepared = await options.source.prepareSessionSource?.();
      prepared?.assertCurrent();
      expect(
        prepared?.checks.some((check) => check.predicate.transcript?.version === sourceVersion),
      ).toBe(true);
      if (report.kind !== "custom") {
        throw new Error("Expected opaque seed marker");
      }
      const selected = report.selectReport(undefined);
      if (selected) {
        savedReports.push({ type: "custom_message", ...selected });
      }
      return { ok: true, value: { committed: true, projectionNeedsReconcile: false } };
    },
  );
});

describe("explicit native conversation history seed", () => {
  it("fences an empty native history without inventing a transcript or completed exchange", async () => {
    sourceVersion = { generation: null, rawSeq: null, updatedAt: null };
    expect(await ensureConversationKnowledgeSeed(params)).toEqual({
      status: "seeded",
      recorded: 0,
      skipped: 0,
    });
    expect(mocks.delta).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.voice).not.toHaveBeenCalled();
    expect(savedReports).toHaveLength(1);
    expect(savedReports[0]?.details).toMatchObject({
      complete: true,
      through: { generation: null, maxSeq: null },
    });
  });

  it("does not mark an empty source complete if a transcript appears before completion", async () => {
    mocks.metadata.mockResolvedValueOnce({
      version: { generation: null, rawSeq: null, updatedAt: null },
    });
    await expect(ensureConversationKnowledgeSeed(params)).rejects.toThrow("source changed");
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it.each(["keyed", "unkeyed"] as const)(
    "selects the exact %s terminal without inventing a private audience",
    async (mode) => {
      const message = {
        ...terminal.event.message,
        idempotencyKey: mode === "keyed" ? "saved-answer" : undefined,
      };
      mocks.raw.mockResolvedValueOnce({
        kind: "page",
        events: [{ ...terminal, event: { ...terminal.event, message } }],
        cursor: "done",
        hasMore: false,
      });
      expect((await ensureConversationKnowledgeSeed(params)).recorded).toBe(1);
      expect(mocks.record).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sourceMode: "native",
          runId: "saved-run",
          assistantTranscriptEntryId: "answer",
          ...(mode === "keyed" ? { assistantTranscriptIdempotencyKey: "saved-answer" } : {}),
        }),
      );
      const request = mocks.record.mock.calls[0]?.[0];
      expect(request).not.toHaveProperty("privateAudience");
      if (mode === "unkeyed") {
        expect(request).not.toHaveProperty("assistantTranscriptIdempotencyKey");
      }
      expect(mocks.context).not.toHaveBeenCalled();
    },
  );

  it("records validated native occurrences in order, then persists one opaque completion marker", async () => {
    expect(await ensureConversationKnowledgeSeed(params)).toEqual({
      status: "seeded",
      recorded: 2,
      skipped: 0,
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMode: "native", runId: "saved-run" }),
    );
    expect(mocks.voice).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMode: "native", anchor, role: "user" }),
    );
    expect(mocks.record.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.voice.mock.invocationCallOrder[0]!,
    );
    expect(mocks.voice.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.append.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(savedReports)).not.toContain("completed answer");
    expect(savedReports[0]?.customType).toBe(CONVERSATION_KNOWLEDGE_SEED);
    mocks.raw.mockClear();
    mocks.reports.mockClear();
    expect((await ensureConversationKnowledgeSeed(params)).status).toBe("already-seeded");
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.reports).toHaveBeenCalledTimes(1);
    expect(mocks.reports).toHaveBeenCalledWith(
      expect.objectContaining({ customTypes: [CONVERSATION_KNOWLEDGE_SEED] }),
    );
  });

  it("resumes a partially recorded source without replacing native idempotency", async () => {
    savedReports.push({
      type: "custom_message",
      customType: CONVERSATION_KNOWLEDGE_REPORT,
      details: {
        version: 1,
        sourceMode: "native",
        source: branch,
        origin: conversationKnowledgeOrigin(branch),
        runId: "saved-run",
        through: anchor,
      },
    });
    expect((await ensureConversationKnowledgeSeed(params)).status).toBe("resumed");
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.reports).toHaveBeenCalledTimes(2);
    expect(mocks.reports).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        customTypes: [CONVERSATION_KNOWLEDGE_REPORT, CONVERSATION_UTTERANCE_REPORT],
      }),
    );
  });

  it.each(["different-source", "incomplete"] as const)(
    "does not skip traversal for a %s completion marker",
    async (mode) => {
      await ensureConversationKnowledgeSeed(params);
      const marker = savedReports[0]!;
      const details = marker.details as Record<string, unknown>;
      marker.details =
        mode === "different-source"
          ? { ...details, seedId: "another-source-incarnation" }
          : { ...details, complete: false };
      mocks.raw.mockClear();
      mocks.reports.mockClear();
      expect((await ensureConversationKnowledgeSeed(params)).status).toBe("seeded");
      expect(mocks.raw).toHaveBeenCalledTimes(1);
      expect(mocks.reports).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps the source assertion live when the completed marker is found", async () => {
    await ensureConversationKnowledgeSeed(params);
    let permitted = true;
    mocks.reports.mockImplementationOnce(async () => {
      permitted = false;
      return savedReports;
    });
    await expect(
      ensureConversationKnowledgeSeed({
        ...params,
        assertCurrent: () => {
          if (!permitted) {
            throw new Error("completed seed permission revoked");
          }
        },
      }),
    ).rejects.toThrow("completed seed permission revoked");
  });

  it.each(["seeded", "already-seeded"] as const)(
    "accepts concurrent activity metadata changes at the awaited %s boundary",
    async (status) => {
      if (status === "already-seeded") {
        await ensureConversationKnowledgeSeed(params);
      }
      mocks.append.mockClear();
      mocks.reports.mockImplementationOnce(async ({ customTypes }: { customTypes: string[] }) => {
        await Promise.resolve();
        projectRead = (facts) => ({
          ...facts,
          entries: facts.entries.map((row) => ({
            ...row,
            entry: row.entry && { ...row.entry, updatedAt: 2, totalTokens: 42 },
          })),
        });
        return savedReports.filter((report) => customTypes.includes(String(report.customType)));
      });
      await expect(ensureConversationKnowledgeSeed(params)).resolves.toMatchObject({ status });
      expect(mocks.append).toHaveBeenCalledTimes(status === "seeded" ? 1 : 0);
    },
  );

  it.each(["seeded", "already-seeded"] as const)(
    "still rejects real authority changes at the awaited %s boundary",
    async (status) => {
      for (const change of ["lifecycle", "audience", "members", "physical-source"] as const) {
        projectRead = (facts) => facts;
        savedReports = [];
        if (status === "already-seeded") {
          await ensureConversationKnowledgeSeed(params);
        }
        mocks.append.mockClear();
        mocks.reports.mockImplementationOnce(async ({ customTypes }: { customTypes: string[] }) => {
          await Promise.resolve();
          projectRead = (facts) => ({
            ...facts,
            ...(change === "physical-source"
              ? { source: { ...facts.source, databaseIdentity: "replaced-identity" } }
              : {}),
            ...(change === "members"
              ? {
                  members: {
                    ...facts.members,
                    [branch.sessionKey]: [
                      { identityId: "other-person", addedBy: "synthetic-owner", addedAt: 2 },
                    ],
                  },
                }
              : {}),
            entries: facts.entries.map((row) => ({
              ...row,
              entry:
                row.sessionKey !== branch.sessionKey || !row.entry
                  ? row.entry
                  : {
                      ...row.entry,
                      ...(change === "lifecycle" ? { lifecycleRevision: "replacement" } : {}),
                      ...(change === "audience" ? { chatType: "group" as const } : {}),
                    },
            })),
          });
          return savedReports.filter((report) => customTypes.includes(String(report.customType)));
        });
        await expect(ensureConversationKnowledgeSeed(params)).rejects.toThrow(
          change === "lifecycle"
            ? "Conversation knowledge seed enrollment changed"
            : "Conversation knowledge seed authority changed",
        );
        expect(mocks.append).not.toHaveBeenCalled();
      }
    },
  );

  it("never marks a partially failed traversal complete and lets a later attempt retry", async () => {
    mocks.voice.mockRejectedValueOnce(new Error("source revoked"));
    await expect(ensureConversationKnowledgeSeed(params)).rejects.toThrow("source revoked");
    expect(mocks.append).not.toHaveBeenCalled();
    expect((await ensureConversationKnowledgeSeed(params)).status).toBe("seeded");
  });

  it("keeps the original source permission live through completion-marker preparation", async () => {
    let permitted = true;
    const source: SessionSourceAssertion = Object.assign(
      () => {
        if (!permitted) {
          throw new Error("seed permission revoked");
        }
      },
      { prepareSessionSource: async () => ({ assertCurrent: source, checks: [] }) },
    );
    mocks.append.mockImplementationOnce(
      async (_target, _report, options: { source: SessionSourceAssertion }) => {
        permitted = false;
        const prepared = await options.source.prepareSessionSource?.();
        prepared?.assertCurrent();
      },
    );
    await expect(
      ensureConversationKnowledgeSeed({ ...params, assertCurrent: source }),
    ).rejects.toThrow("seed permission revoked");
    expect(savedReports).toEqual([]);
  });

  it("reads finite pages without restarting the completed prefix", async () => {
    mocks.raw
      .mockReset()
      .mockResolvedValueOnce({
        kind: "page",
        events: [terminal],
        cursor: "next-page",
        hasMore: true,
      })
      .mockResolvedValueOnce({ kind: "page", events: [voice], cursor: "done", hasMore: false });
    await ensureConversationKnowledgeSeed(params);
    expect(mocks.raw).toHaveBeenCalledTimes(2);
    expect(mocks.raw).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: "next-page",
        maxEvents: 96,
        maxBytes: 1_000_000,
        activePathOnly: true,
      }),
    );
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.voice).toHaveBeenCalledTimes(1);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
    expect(mocks.metadata).toHaveBeenCalledWith({ operation: "version" });
  });

  it("skips missing native metadata and lets the recorder refuse incomplete tool work", async () => {
    mocks.raw.mockResolvedValueOnce({
      kind: "page",
      cursor: "done",
      hasMore: false,
      events: [
        terminal,
        {
          ...terminal,
          seq: 4,
          event: {
            ...terminal.event,
            id: "unattributed",
            message: {
              role: "assistant",
              content: "No saved native ownership.",
              stopReason: "stop",
            },
          },
        },
      ],
    });
    mocks.record.mockResolvedValueOnce(false);
    expect(await ensureConversationKnowledgeSeed(params)).toEqual({
      status: "seeded",
      recorded: 0,
      skipped: 2,
    });
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it("completes paged history larger than one model-context event window", async () => {
    const count = CONVERSATION_KNOWLEDGE_SOURCE_LIMITS.maxEvents + 1;
    sourceVersion = { ...version, rawSeq: count };
    const rows = Array.from({ length: count }, (_, index) => ({
      seq: index + 1,
      event: {
        type: "message",
        id: `unanswered-${index}`,
        message: { role: "user", content: "An unanswered historical input." },
      },
    }));
    mocks.raw.mockImplementation(async ({ cursor, maxEvents }) => {
      const start = Number(cursor ?? 0);
      const end = Math.min(start + maxEvents, rows.length);
      return {
        kind: "page",
        events: rows.slice(start, end),
        cursor: String(end),
        hasMore: end < rows.length,
      };
    });
    expect(await ensureConversationKnowledgeSeed(params)).toEqual({
      status: "seeded",
      recorded: 0,
      skipped: count,
    });
    expect(mocks.raw).toHaveBeenCalledTimes(Math.ceil(count / 96));
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
    expect(savedReports).toHaveLength(1);
  });

  it("leaves an oversized single raw entry pending without a completion marker", async () => {
    mocks.raw.mockResolvedValueOnce({
      kind: "page",
      events: [],
      cursor: "oversized",
      hasMore: true,
      requiredBytes: CONVERSATION_KNOWLEDGE_SOURCE_LIMITS.maxBytes + 1,
    });
    await expect(ensureConversationKnowledgeSeed(params)).resolves.toEqual({
      status: "pending",
      reason: "source-capacity",
      recorded: 0,
      skipped: 0,
    });
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("stops at a validation-capacity hole without skipping or publishing later endpoints", async () => {
    mocks.record.mockRejectedValueOnce(new ConversationKnowledgeSourceCapacityError());
    expect(await ensureConversationKnowledgeSeed(params)).toEqual({
      status: "pending",
      reason: "source-capacity",
      recorded: 0,
      skipped: 0,
    });
    expect(mocks.voice).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
  });

  it("does not classify arbitrary read or authority errors as capacity", async () => {
    mocks.record.mockRejectedValueOnce(new RangeError("Invalid native range"));
    await expect(ensureConversationKnowledgeSeed(params)).rejects.toThrow("Invalid native range");
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("rechecks authority before returning a typed capacity disposition", async () => {
    let current = true;
    mocks.record.mockImplementationOnce(async () => {
      current = false;
      throw new ConversationKnowledgeSourceCapacityError();
    });
    await expect(
      ensureConversationKnowledgeSeed({
        ...params,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Pending seed authority revoked");
          }
        },
      }),
    ).rejects.toThrow("Pending seed authority revoked");
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it.each([0, 1_000_000, Number.NaN])(
    "rejects invalid native byte progress %s",
    async (requiredBytes) => {
      mocks.raw.mockResolvedValueOnce({
        kind: "page",
        events: [],
        cursor: "invalid",
        hasMore: true,
        requiredBytes,
      });
      await expect(ensureConversationKnowledgeSeed(params)).rejects.toThrow("made no progress");
      expect(mocks.append).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...version, generation: "replacement-generation" },
    { ...version, rawSeq: 9 },
    { ...version, updatedAt: 2 },
    undefined,
  ])("refuses changed or missing final metadata without a marker (%j)", async (changed) => {
    mocks.metadata.mockResolvedValueOnce({ version }).mockResolvedValueOnce({ version: changed });
    await expect(ensureConversationKnowledgeSeed(params)).rejects.toThrow("source changed");
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("keeps metadata source revocation fatal before writing a completion marker", async () => {
    mocks.metadataCurrent
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("metadata source revoked");
      });
    await expect(ensureConversationKnowledgeSeed(params)).rejects.toThrow(
      "metadata source revoked",
    );
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("refuses missing initial metadata without traversing or completing", async () => {
    mocks.metadata.mockResolvedValueOnce({});
    await expect(ensureConversationKnowledgeSeed(params)).rejects.toThrow("version is unavailable");
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("does not acquire history or write a marker for an unenrolled session", async () => {
    mocks.branch.mockResolvedValueOnce(undefined);
    expect((await ensureConversationKnowledgeSeed(params)).status).toBe("not-enrolled");
    expect(mocks.reports).not.toHaveBeenCalled();
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });
});
