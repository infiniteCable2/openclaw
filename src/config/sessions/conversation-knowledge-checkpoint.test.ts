import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { describe, expect, it, vi } from "vitest";
import { conversationKnowledgeParticipantIdentity } from "./conversation-audience.js";
import {
  createConversationKnowledgeCheckpointContext,
  resolveConversationKnowledgeImportProgress,
  snapshotConversationKnowledgeProgress,
} from "./conversation-knowledge-checkpoint-context.js";
import {
  createConversationKnowledgeCheckpoint,
  prepareConversationKnowledgeCheckpointCoverage,
  readConversationKnowledgeCheckpoint,
  selectConversationKnowledgeCheckpointBootstrap,
  selectConversationKnowledgeCheckpointReport,
  type ConversationKnowledgeCheckpoint,
  PreparedConversationKnowledgeCheckpointCoverage,
} from "./conversation-knowledge-checkpoint.js";
import { conversationKnowledgeContributionId } from "./conversation-knowledge-identity.js";
import type { ConversationKnowledgeBranch } from "./conversation-knowledge-store.js";
import {
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";

const person = { type: "profile", id: "example-person" } as const;
const audienceKey = conversationKnowledgeParticipantIdentity(person)!;
const branch: ConversationKnowledgeBranch = {
  agentId: "example",
  storePath: "/synthetic/sessions.sqlite",
  sessionKey: "agent:example:recipient",
  sessionId: "recipient-instance",
  lifecycleRevision: "recipient-life",
  root: {
    sessionKey: "agent:example:root",
    sessionId: "root-instance",
    lifecycleRevision: "root-life",
  },
};
function reference(index: number, sourceId = "donor-instance"): ConversationKnowledgeReference {
  const source = {
    agentId: branch.agentId,
    sessionKey: "agent:example:donor",
    sessionId: sourceId,
    lifecycleRevision: "donor-life",
  };
  const through = {
    ...source,
    storePath: branch.storePath,
    generation: "generation-one",
    rawSeq: index,
    entryId: `message-${index}`,
    activeMessagePosition: index,
    effectiveParentId: null,
  };
  return {
    version: 1,
    sourceMode: "branches",
    source,
    origin: conversationKnowledgeOrigin(source, "utterance-observation"),
    through,
    kind: "utterance-observation",
    role: "user",
    privateAudience: { participant: person, admission: through },
  };
}
const create = (covered = [reference(1)]) =>
  createConversationKnowledgeCheckpoint({
    branch,
    audienceKey,
    covered,
    summary: "The synthetic user selected a blue light.",
  });
const prepare = (checkpoint: ConversationKnowledgeCheckpoint, records = [checkpoint]) =>
  prepareConversationKnowledgeCheckpointCoverage({ checkpoint, records, assertCurrent: () => {} });

// Deliberately valid hashes isolate lineage validation from payload-integrity validation.
function rehash(
  checkpoint: ConversationKnowledgeCheckpoint,
  changes: Partial<ConversationKnowledgeCheckpoint>,
) {
  const { checkpointId: _id, ...content } = { ...checkpoint, ...changes };
  return { ...content, checkpointId: sha256Hex(JSON.stringify(content)) };
}
describe("conversation checkpoint coverage", () => {
  it("preserves exact gaps and rejects mixed people, duplicate occurrences and altered payloads", () => {
    const first = reference(1),
      third = reference(3);
    const checkpoint = create([first, third]);
    expect(checkpoint.coveredContributionIds).toEqual(
      [first, third].map(conversationKnowledgeContributionId),
    );
    expect(readConversationKnowledgeCheckpoint(checkpoint)).toEqual(checkpoint);
    expect(
      readConversationKnowledgeCheckpoint({ ...checkpoint, summary: "Altered" }),
    ).toBeUndefined();
    expect(
      readConversationKnowledgeCheckpoint({ ...checkpoint, checkpointId: "forged" }),
    ).toBeUndefined();
    expect(() => create([first, first])).toThrow("cannot repeat");
    expect(() =>
      create([
        {
          ...first,
          privateAudience: {
            ...first.privateAudience!,
            participant: { type: "profile", id: "other-person" },
          },
        },
      ]),
    ).toThrow("mixed-audience");
  });
  it("publishes delta coverage by CAS, resumes identical writes, and rejects replay", () => {
    const first = create(),
      previousCoverage = prepare(first);
    const firstReport = selectConversationKnowledgeCheckpointReport(first, undefined)!;
    expect(selectConversationKnowledgeCheckpointReport(first, firstReport)).toBeUndefined();
    const next = createConversationKnowledgeCheckpoint({
      branch,
      audienceKey,
      previous: first,
      previousCoverage,
      covered: [reference(3)],
      summary: "Updated summary.",
    });
    expect(next.coveredContributionIds).toEqual([
      conversationKnowledgeContributionId(reference(3)),
    ]);
    expect(
      selectConversationKnowledgeCheckpointReport(next, firstReport, previousCoverage)?.details,
    ).toEqual(next);
    expect(() =>
      selectConversationKnowledgeCheckpointReport(next, undefined, previousCoverage),
    ).toThrow("predecessor changed");
    const concurrent = createConversationKnowledgeCheckpoint({
      branch,
      audienceKey,
      previous: first,
      previousCoverage,
      covered: [reference(2)],
      summary: "Concurrent summary.",
    });
    expect(() =>
      selectConversationKnowledgeCheckpointReport(
        next,
        selectConversationKnowledgeCheckpointReport(concurrent, firstReport, previousCoverage),
        previousCoverage,
      ),
    ).toThrow("predecessor changed");
    expect(() =>
      createConversationKnowledgeCheckpoint({
        branch,
        audienceKey,
        previous: first,
        previousCoverage,
        covered: [reference(1)],
        summary: "Duplicated.",
      }),
    ).toThrow("cannot repeat");
    const proof = prepare(next, [first, next]);
    expect([...proof.contributionIds()].toSorted()).toEqual(
      [reference(1), reference(3)].map(conversationKnowledgeContributionId).toSorted(),
    );
    expect(() => prepare(next, [next])).toThrow("missing");
    const replay = rehash(next, { coveredContributionIds: first.coveredContributionIds });
    expect(() => prepare(replay, [first, replay])).toThrow("repeats");
    expect(() =>
      selectConversationKnowledgeCheckpointReport(replay, firstReport, previousCoverage),
    ).toThrow("cannot repeat");
    const differentAudience = rehash(next, { audienceKey: "another-person" });
    expect(() => prepare(differentAudience, [first, differentAudience])).toThrow(
      "outside its audience",
    );
    expect(() => prepare(next, [first, { ...next, summary: "corrupt" }])).toThrow("invalid record");
  });
  it("binds summary coverage to the consumed range even when the occurrence ID is unchanged", () => {
    const original = reference(2);
    const checkpoint = create([original]);
    const coverage = prepare(checkpoint);
    expect(coverage.matchesReference(original)).toBe(true);
    expect(
      coverage.matchesReference(original, {
        through: original.through,
        from: original.privateAudience!.admission,
      }),
    ).toBe(true);
    const rewritten = {
      ...original,
      readRange: { through: reference(3).through, admission: reference(1).through },
    };
    expect(conversationKnowledgeContributionId(rewritten)).toBe(
      conversationKnowledgeContributionId(original),
    );
    expect(coverage.matchesReference(rewritten)).toBe(false);
    expect(coverage.matchesReference(original, { through: original.through })).toBe(false);
    const renewed = {
      ...original,
      readRange: {
        through: { ...original.through, generation: "native-unchanged-prefix" },
        admission: {
          ...original.privateAudience!.admission,
          generation: "native-unchanged-prefix",
        },
      },
    };
    expect(
      coverage.matchesReference(renewed, {
        through: renewed.readRange.through,
        from: renewed.readRange.admission,
      }),
    ).toBe(true);
    expect(
      coverage.matchesReference(renewed, {
        through: original.through,
        from: original.privateAudience!.admission,
      }),
    ).toBe(false);
    expect(
      selectConversationKnowledgeCheckpointBootstrap({
        checkpoint,
        coverage,
        branch,
        audienceKey,
        progress: new Map(),
        availableReferences: [rewritten],
      }),
    ).toBeUndefined();
    expect(
      readConversationKnowledgeCheckpoint({ ...checkpoint, coveredRangeDigests: [] }),
    ).toBeUndefined();
  });
  it("bootstraps only absent imported progress and keeps exact gaps pending", () => {
    const checkpoint = create([reference(1), reference(3)]),
      coverage = prepare(checkpoint);
    const input = {
      checkpoint,
      coverage,
      branch,
      audienceKey,
      progress: new Map(),
      availableReferences: [reference(1), reference(2), reference(3)],
    };
    expect(selectConversationKnowledgeCheckpointBootstrap(input)).toEqual(checkpoint);
    expect(coverage.has(conversationKnowledgeContributionId(reference(2)))).toBe(false);
    expect(
      selectConversationKnowledgeCheckpointBootstrap({
        ...input,
        progress: new Map([["partial", { complete: false, nextOffset: 12 }]]),
      }),
    ).toBeUndefined();
    expect(
      selectConversationKnowledgeCheckpointBootstrap({ ...input, hasCheckpointReceipt: true }),
    ).toBeUndefined();
    expect(
      selectConversationKnowledgeCheckpointBootstrap({
        ...input,
        availableReferences: [reference(1)],
      }),
    ).toBeUndefined();
  });
  it("does not grant another audience, replaced source, root incarnation or self replay", () => {
    const checkpoint = create();
    const input = {
      checkpoint,
      coverage: prepare(checkpoint),
      branch,
      audienceKey,
      progress: new Map(),
      availableReferences: [reference(1)],
    };
    expect(
      selectConversationKnowledgeCheckpointBootstrap({ ...input, audienceKey: "other-person" }),
    ).toBeUndefined();
    expect(
      selectConversationKnowledgeCheckpointBootstrap({
        ...input,
        availableReferences: [reference(1, "replacement-instance")],
      }),
    ).toBeUndefined();
    expect(
      selectConversationKnowledgeCheckpointBootstrap({
        ...input,
        branch: { ...branch, root: { ...branch.root, lifecycleRevision: "replacement-root" } },
      }),
    ).toBeUndefined();
    expect(
      selectConversationKnowledgeCheckpointBootstrap({
        ...input,
        branch: { ...branch, ...reference(1).source },
      }),
    ).toBeUndefined();
    expect(
      selectConversationKnowledgeCheckpointBootstrap({
        ...input,
        branch: { ...branch, ...reference(1).source, lifecycleRevision: "new-recipient-life" },
      }),
    ).toEqual(checkpoint);
  });
  it("keeps child metadata constant-sized and requires a prepared exact proof without context reads", () => {
    const small = create(),
      large = create(Array.from({ length: 300 }, (_, index) => reference(index + 1)));
    const smallCarrier = createConversationKnowledgeCheckpointContext({
      checkpoint: small,
      branch,
    });
    const largeCarrier = createConversationKnowledgeCheckpointContext({
      checkpoint: large,
      branch,
    });
    expect(JSON.stringify(smallCarrier.details).length).toBe(
      JSON.stringify(largeCarrier.details).length,
    );
    expect(largeCarrier.content).toBe(smallCarrier.content);
    expect(largeCarrier.details).not.toHaveProperty("coveredContributionIds");
    const imports = { packets: new Map(), checkpoints: [largeCarrier.details] };
    expect(() => resolveConversationKnowledgeImportProgress({ branch, imports })).toThrow(
      "not prepared",
    );
    const progress = resolveConversationKnowledgeImportProgress({
      branch,
      imports,
      checkpointCoverage: new Map([[large.checkpointId, prepare(large)]]),
    });
    expect(progress.size).toBe(300);
    expect(progress.get(conversationKnowledgeContributionId(reference(2)))).toEqual({
      complete: true,
      nextOffset: 0,
      coverage: "summary",
    });
    expect(() =>
      resolveConversationKnowledgeImportProgress({
        branch,
        imports,
        checkpointCoverage: new Map([[large.checkpointId, prepare(small)]]),
      }),
    ).toThrow("does not match");
  });
  it("shares summary membership without enumerating IDs when resolving or caching progress", () => {
    const checkpoint = create(Array.from({ length: 300 }, (_, index) => reference(index + 1)));
    const coverage = prepare(checkpoint);
    const carrier = createConversationKnowledgeCheckpointContext({ checkpoint, branch });
    const exactId = conversationKnowledgeContributionId(reference(1));
    const partialId = conversationKnowledgeContributionId(reference(2));
    const enumerate = vi
      .spyOn(PreparedConversationKnowledgeCheckpointCoverage.prototype, "contributionIds")
      .mockImplementation(() => {
        throw new Error("unexpected coverage enumeration");
      });
    try {
      const packets = new Map([
        [exactId, { complete: true, nextOffset: 42 }],
        [partialId, { complete: false, nextOffset: 5 }],
      ]);
      const progress = resolveConversationKnowledgeImportProgress({
        branch,
        imports: { packets, checkpoints: [carrier.details] },
        checkpointCoverage: new Map([[checkpoint.checkpointId, coverage]]),
      });
      packets.clear();
      expect(progress.get(exactId)).toEqual({ complete: true, nextOffset: 42 });
      expect(progress.get(partialId)).toEqual({
        complete: true,
        nextOffset: 0,
        coverage: "summary",
      });
      expect(progress.size).toBe(300);
      const snapshot = snapshotConversationKnowledgeProgress(progress);
      expect(snapshot.progress).toBe(progress);
      expect(snapshot.byteLength).toBeLessThan(512);
      expect(enumerate).not.toHaveBeenCalled();
    } finally {
      enumerate.mockRestore();
    }
  });
});
