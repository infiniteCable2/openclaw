import { beforeEach, expect, it, vi } from "vitest";
import { MAX_SESSION_MODEL_CONTEXT_BATCH_RANGES as maximum } from "../../config/sessions/session-model-context-batch-limits.js";
import { readSessionTranscriptModelContextsAsync } from "../../config/sessions/session-transcript-context-read.js";
import { readConversationKnowledgeSourceBatch } from "./conversation-knowledge-source-batch.js";

vi.mock("../../config/sessions/session-transcript-context-read.js", () => ({
  readSessionTranscriptModelContextsAsync: vi.fn(),
}));

type Request = Parameters<typeof readConversationKnowledgeSourceBatch>[0];

const target = {
  agentId: "main",
  sessionKey: "agent:main:synthetic",
  sessionId: "synthetic-session",
  storePath: "/synthetic/agent.sqlite",
};

function fixture() {
  const sources = Array.from({ length: maximum }, (_, index) => {
    const through = {
      ...target,
      generation: "generation",
      entryId: "entry-" + index,
      rawSeq: index + 1,
      effectiveParentId: null,
      activeMessagePosition: index,
    };
    const reference = {
      source: { ...target, lifecycleRevision: "revision" },
      through,
    } as Request["receipt"];
    // This fixture supplies already-admitted sources and tests the native read boundary.
    const source = {
      read: { index },
      projectionTarget: target,
      through,
      from: through,
      sourceAssertion: vi.fn(),
      grant: {
        contributionRange: { from: through },
        sources: [
          {
            lifecycleRevision: "revision",
            readSource: { agentId: target.agentId, path: target.storePath, databaseIdentity: "db" },
          },
        ],
      },
    } as unknown as Request["current"];
    return { reference, source };
  });
  const drop = vi.fn();
  return {
    sources,
    drop,
    request: {
      current: sources[0]!.source,
      receipt: sources[0]!.reference,
      successors: sources.slice(1).map(({ reference }) => reference),
      prepareNext: async (reference) =>
        sources.find((entry) => entry.reference === reference)?.source,
      drop,
      assertCurrent() {},
    } satisfies Request,
  };
}

const failedRange = { ok: false, reason: "source-range-over-capacity" } as const;
const native = vi.mocked(readSessionTranscriptModelContextsAsync);

beforeEach(() => {
  native.mockReset();
});

it("narrows a failed batch and frees every successor outside the accepted window", async () => {
  const { request, sources, drop } = fixture();
  native.mockRejectedValueOnce(new Error("Synthetic batch acquisition failure"));
  native.mockImplementation(async (_target, ranges, consume) =>
    consume(
      ranges.length > 2 ? [failedRange] : ranges.map(() => ({ ok: true, context: { events: [] } })),
    ),
  );

  const result = await readConversationKnowledgeSourceBatch(request);

  expect(native.mock.calls.map(([, ranges]) => ranges.length)).toEqual(
    maximum === 8 ? [8, 4, 2] : [4, 2],
  );
  expect(native.mock.calls.map(([, ranges]) => ranges[0]!.limits.maxBytes / 1024 ** 2)).toEqual(
    maximum === 8 ? [24, 48, 64] : [48, 64],
  );
  expect(result?.next.map(({ source }) => source)).toEqual([sources[1]!.source]);
  expect(drop.mock.calls.map(([read]) => read)).toEqual(
    sources.slice(2).map(({ source }) => source.read),
  );
});

it("leaves a successor that exceeds its temporary share eligible for its own read", async () => {
  const { request, sources, drop } = fixture();
  native.mockImplementationOnce(async (_target, ranges, consume) =>
    consume(
      ranges.map((_, index) => (index === 2 ? failedRange : { ok: true, context: { events: [] } })),
    ),
  );

  const result = await readConversationKnowledgeSourceBatch(request);

  expect(result?.next.map(({ source }) => source)).toEqual(
    sources
      .slice(1)
      .filter((_, index) => index !== 1)
      .map(({ source }) => source),
  );
  expect(drop).toHaveBeenCalledExactlyOnceWith(sources[2]!.source.read);
});

it("stops retries and releases successors when the original read is cancelled", async () => {
  const { request, drop } = fixture();
  const controller = new AbortController();
  const reason = new Error("Synthetic cancellation");
  native.mockImplementationOnce(async () => {
    controller.abort(reason);
    throw reason;
  });

  await expect(
    readConversationKnowledgeSourceBatch({ ...request, signal: controller.signal }),
  ).rejects.toBe(reason);

  expect(native).toHaveBeenCalledTimes(1);
  expect(drop).toHaveBeenCalledTimes(maximum - 1);
});

it("lets the caller read the current range alone after bounded retries fail", async () => {
  const { request, drop } = fixture();
  native.mockRejectedValue(new Error("Synthetic native read failure"));

  await expect(readConversationKnowledgeSourceBatch(request)).resolves.toBeUndefined();

  expect(native.mock.calls.map(([, ranges]) => ranges.length)).toEqual(
    maximum === 8 ? [8, 4, 2] : [4, 2],
  );
  expect(drop).toHaveBeenCalledTimes(maximum - 1);
});
