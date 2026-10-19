import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_KNOWLEDGE_SEED,
  ensureConversationKnowledgeSeed,
} from "./conversation-knowledge-seed.js";
import {
  conversationKnowledgeOrigin,
  CONVERSATION_KNOWLEDGE_REPORT,
  CONVERSATION_UTTERANCE_REPORT,
} from "./conversation-knowledge.js";
import type { TranscriptReport } from "./session-accessor.sqlite-transcript-reports.types.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { SessionEntryCohortResult } from "./session-entry-read.types.js";
import type { SessionTranscriptModelContext } from "./session-history-read.types.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";

const mocks = vi.hoisted(() => ({
  branch: vi.fn(),
  reports: vi.fn(),
  raw: vi.fn(),
  delta: vi.fn(),
  watermark: vi.fn(),
  context: vi.fn(),
  record: vi.fn(),
  voice: vi.fn(),
  anchor: vi.fn(),
  append: vi.fn(),
}));
// mock-isolation: Exercise the bounded seed protocol without databases, workers or model execution.
vi.mock("./conversation-knowledge-store.js", () => ({
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
// mock-isolation: Pin the source prefix without acquiring native storage.
vi.mock("./session-transcript-watermark.js", () => ({
  readSessionTranscriptWatermarkAsync: mocks.watermark,
}));
// mock-isolation: Provide bounded context-version outcomes without hydrating transcript payloads.
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
    return consume(facts, assertSource);
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
  savedReports = [];
  sourceVersion = version;
  mocks.branch.mockResolvedValue(branch);
  mocks.reports.mockImplementation(async ({ customTypes }: { customTypes: string[] }) =>
    savedReports.filter((report) => customTypes.includes(String(report.customType))),
  );
  mocks.watermark.mockResolvedValue({ generation: version.generation, maxSeq: version.rawSeq });
  mocks.raw.mockResolvedValue({
    kind: "page",
    events: [terminal, voice],
    cursor: "done",
    hasMore: false,
  });
  mocks.delta.mockImplementation(async (_target, consume) => consume({ raw: mocks.raw }));
  mocks.context.mockImplementation(
    async (_target, consume: (context: SessionTranscriptModelContext) => unknown) =>
      consume({ events: [], version: sourceVersion }),
  );
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
    mocks.watermark.mockResolvedValue({ generation: null, maxSeq: null });
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
    mocks.watermark.mockResolvedValue({ generation: null, maxSeq: null });
    await expect(ensureConversationKnowledgeSeed(params)).rejects.toThrow("source changed");
    expect(mocks.append).not.toHaveBeenCalled();
  });

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

  it.each(["changed", "truncated"] as const)(
    "refuses %s source completion without a marker",
    async (mode) => {
      mocks.context.mockImplementationOnce(async (_target, consume) =>
        consume({
          events: [],
          version: mode === "changed" ? { ...version, rawSeq: 9 } : version,
          ...(mode === "truncated" ? { truncated: true } : {}),
        }),
      );
      await expect(ensureConversationKnowledgeSeed(params)).rejects.toThrow(
        mode === "changed" ? "source changed" : "seed budget",
      );
      expect(mocks.append).not.toHaveBeenCalled();
    },
  );

  it("does not acquire history or write a marker for an unenrolled session", async () => {
    mocks.branch.mockResolvedValueOnce(undefined);
    expect((await ensureConversationKnowledgeSeed(params)).status).toBe("not-enrolled");
    expect(mocks.reports).not.toHaveBeenCalled();
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });
});
