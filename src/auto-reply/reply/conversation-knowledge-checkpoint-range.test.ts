import { beforeEach, expect, it, vi } from "vitest";
import { conversationKnowledgeOrigin } from "../../config/sessions/conversation-knowledge.js";
import { validateCheckpointCachedPackets } from "./conversation-knowledge-checkpoint-range.js";

const boundary = vi.hoisted(() => ({ anchors: vi.fn() }));
// mock-isolation: Control worker completion while keeping cache classification and live guards real.
vi.mock("../../config/sessions/session-transcript-anchor-read.js", () => ({
  readSessionTranscriptAnchorsAsync: boundary.anchors,
}));

function fixture(count = 32, oldPrefixes = false) {
  const source = {
    agentId: "example",
    sessionKey: "agent:example:donor",
    sessionId: "donor-instance",
    lifecycleRevision: "donor-life",
  };
  const version = { generation: "current", rawSeq: 100, updatedAt: 100 };
  const origin = conversationKnowledgeOrigin(source, "utterance-observation");
  const selected: Parameters<typeof validateCheckpointCachedPackets>[0]["selected"] = Array.from(
    { length: count },
    (_, index) => {
      const through = {
        ...source,
        storePath: "/synthetic/range.sqlite",
        generation: version.generation,
        entryId: `original-${index}`,
        rawSeq: index + 1,
        activeMessagePosition: index,
        effectiveParentId: null,
      };
      return {
        reference: {
          version: 1,
          sourceMode: "branches",
          source,
          origin,
          through,
          kind: "utterance-observation",
          role: "user",
          privateAudience: {
            participant: { type: "profile", id: "synthetic-person" },
            admission: through,
          },
        },
        range: { through, from: through, version },
        packet: {
          part: {
            origin,
            text: "synthetic",
            complete: true,
            nextOffset: undefined,
            frontier: undefined,
          },
          through,
          from: through,
          version: oldPrefixes
            ? { ...version, rawSeq: (index % 2) + 90, updatedAt: (index % 2) + 90 }
            : version,
        },
      };
    },
  );
  return {
    selected,
    target: { ...source, storePath: "/synthetic/range.sqlite" },
    signal: new AbortController().signal,
  };
}

beforeEach(() => vi.resetAllMocks());

it.each([false, true])(
  "checks a cached scan once between native reads: prefixes=%s",
  async (oldPrefixes) => {
    const input = fixture(32, oldPrefixes);
    boundary.anchors.mockResolvedValue({
      anchors: [],
      contextValidated: true,
      contextPrefixMatches: [true, true],
    });
    const check = vi.fn();
    expect(await validateCheckpointCachedPackets({ ...input, check })).toBe(true);
    expect(check).toHaveBeenCalledTimes(oldPrefixes ? 5 : 3);
    expect(boundary.anchors).toHaveBeenCalledTimes(oldPrefixes ? 1 : 0);
    expect(boundary.anchors.mock.calls[0]?.[1]?.contextPrefixVersions?.length).toBe(
      oldPrefixes ? 2 : undefined,
    );
  },
);

it("refuses revoked source custody after a native read before invalidating cached packets", async () => {
  const input = fixture(1, true);
  let live = true;
  boundary.anchors.mockImplementation(async () => {
    live = false;
    return { anchors: [], contextValidated: false };
  });
  const invalidCached = vi.fn();
  const check = () => {
    if (!live) {
      throw new Error("Synthetic source custody revoked");
    }
  };
  await expect(validateCheckpointCachedPackets({ ...input, check, invalidCached })).rejects.toThrow(
    "Synthetic source custody revoked",
  );
  expect(boundary.anchors).toHaveBeenCalledOnce();
  expect(invalidCached).not.toHaveBeenCalled();
});

it("preserves the existing guards for an empty scan", async () => {
  const check = vi.fn();
  expect(await validateCheckpointCachedPackets({ ...fixture(0), check })).toBe(true);
  expect(check).toHaveBeenCalledTimes(2);
  expect(boundary.anchors).not.toHaveBeenCalled();
});
