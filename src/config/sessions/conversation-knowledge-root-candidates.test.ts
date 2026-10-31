import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationKnowledgeSourceCache } from "../../auto-reply/reply/conversation-knowledge-source-cache.js";
import { conversationKnowledgeParticipantIdentity } from "./conversation-audience.js";
import { prepareConversationKnowledgeCheckpointSelection } from "./conversation-knowledge-checkpoint-admission.js";
import {
  createConversationKnowledgeCheckpoint,
  prepareConversationKnowledgeCheckpointCoverage,
  PreparedConversationKnowledgeCheckpointCoverage,
} from "./conversation-knowledge-checkpoint.js";
import {
  assertNativeKnowledgeRootContribution,
  assertNativeKnowledgeRootContributionGroup,
  prepareNativeKnowledgeRootContributionGroup,
  prepareConversationKnowledgeRootSubset,
  issuePreparedKnowledgeRootCandidates,
  readConversationKnowledgeRoot,
  readPreparedConversationKnowledgeRoot,
  readPreparedConversationKnowledgeRootEvidence,
  type ConversationKnowledgeBranch,
  type PreparedKnowledgeRootCandidates,
} from "./conversation-knowledge-store.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReference,
} from "./conversation-knowledge.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { SessionEntryCohortResult } from "./session-entry-read.types.js";
import type { SessionTranscriptModelContext } from "./session-history-read.types.js";

const boundary = vi.hoisted(() => ({ reports: vi.fn() }));
// The private provenance brands, exact reference selection and fresh rebind checks remain real.
// mock-isolation: Supply native report/read facts without opening SQLite workers.
vi.mock("./conversation-knowledge-history.js", () => ({
  readConversationKnowledgeRootReports: async (params: { revalidate(): Promise<void> }) => {
    const reports = await boundary.reports(params);
    await params.revalidate();
    // Native reads return a fresh carrier for each evidence attachment.
    return [...reports];
  },
}));

function fixture() {
  const branch: ConversationKnowledgeBranch = {
    agentId: "example",
    storePath: "/synthetic/agent.sqlite",
    sessionKey: "agent:example:recipient",
    sessionId: "recipient",
    lifecycleRevision: "recipient-life",
    root: {
      sessionKey: "agent:example:conversation-root",
      sessionId: "root",
      lifecycleRevision: "root-life",
    },
  };
  const donor = {
    agentId: branch.agentId,
    sessionKey: "agent:example:donor",
    sessionId: "donor",
    lifecycleRevision: "donor-life",
  };
  const through = {
    agentId: donor.agentId,
    sessionKey: donor.sessionKey,
    sessionId: donor.sessionId,
    storePath: branch.storePath,
    generation: "donor-generation",
    entryId: "answer",
    rawSeq: 3,
    activeMessagePosition: 2,
    effectiveParentId: "question",
  };
  const receipt: ConversationKnowledgeReference = {
    version: 1,
    sourceMode: "branches",
    source: donor,
    origin: conversationKnowledgeOrigin(donor),
    runId: "donor-run",
    through,
    privateAudience: {
      participant: { type: "profile", id: "person-example" },
      admission: {
        ...through,
        entryId: "question",
        rawSeq: 2,
        activeMessagePosition: 1,
        effectiveParentId: null,
      },
    },
  };
  const events = [
    {
      type: "custom_message",
      id: "root-report",
      customType: CONVERSATION_KNOWLEDGE_REPORT,
      display: false,
      content: "An exact native contribution reference.",
      details: structuredClone(receipt),
    },
  ] satisfies TranscriptEvent[];
  const source = {
    agentId: branch.agentId,
    path: branch.storePath,
    databaseIdentity: "physical-original",
    databaseBirthtime: "original-birthtime",
  };
  const rootEntry = {
    sessionId: branch.root.sessionId,
    lifecycleRevision: branch.root.lifecycleRevision,
    updatedAt: 1,
    createdVia: "internal" as const,
    createdActor: { type: "system" as const, id: "conversation-root" },
    visibility: "draft" as const,
    delivery: { kind: "none" as const },
    conversationTopology: { version: 1 as const, role: "root" as const },
  };
  let cohorts = 0;
  let readerCurrent = true;
  const checkReader = () => {
    if (!readerCurrent) {
      throw new Error("Native reader released");
    }
  };
  const reader: SessionEntryCohortReader = {
    database: { agentId: branch.agentId, path: branch.storePath, env: {} },
    sessionKey: branch.sessionKey,
    logicalAgentId: branch.agentId,
    storePaths: [branch.storePath],
    assertCurrent: checkReader,
    async withRead(request, assertCurrent, consume) {
      checkReader();
      assertCurrent();
      cohorts++;
      const facts: SessionEntryCohortResult = {
        kind: "session-exact-entries",
        source: { ...source },
        databaseIdentity: {
          identity: source.databaseIdentity,
          incarnation: "native-incarnation",
          filename: source.path,
          birthtime: source.databaseBirthtime,
        },
        entries: [
          {
            sessionKey: branch.sessionKey,
            entry: {
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
            },
          },
          { sessionKey: branch.root.sessionKey, entry: structuredClone(rootEntry) },
        ].filter((entry) => request.sessionKeys.includes(entry.sessionKey)),
        lifecycleTimestamps: {},
      };
      return consume(facts, checkReader);
    },
  };
  boundary.reports.mockResolvedValue(events);
  return {
    branch,
    receipt,
    events,
    reader,
    source,
    rootEntry,
    cohorts: () => cohorts,
    releaseReader: () => {
      readerCurrent = false;
    },
  };
}

beforeEach(() => boundary.reports.mockReset());

describe("prepared native knowledge root candidates", () => {
  it("rebinds an unchanged donor subset across an unrelated root append without another native read", async () => {
    const f = fixture();
    let originalCurrent = true;
    const original = await readConversationKnowledgeRoot({
      ...f,
      assertCurrent() {
        f.reader.assertCurrent();
        if (!originalCurrent) {
          throw new Error("Original preparation released");
        }
      },
    });
    const subset = prepareConversationKnowledgeRootSubset({
      evidence: original.evidence,
      branch: f.branch,
      references: [f.receipt],
      maxBytes: 4096,
    });
    const proof = prepareNativeKnowledgeRootContributionGroup(subset.evidence, f.branch, [
      f.receipt,
    ]);
    const otherSource = {
      ...f.receipt.source,
      sessionKey: "agent:example:other",
      sessionId: "other-donor",
    };
    const otherThrough = {
      ...f.receipt.through,
      agentId: otherSource.agentId,
      sessionKey: otherSource.sessionKey,
      sessionId: otherSource.sessionId,
      entryId: "unrelated",
    };
    const unrelated = {
      ...f.receipt,
      source: otherSource,
      origin: conversationKnowledgeOrigin(otherSource),
      through: otherThrough,
      privateAudience: {
        participant: f.receipt.privateAudience!.participant,
        admission: {
          ...otherThrough,
          entryId: "other-question",
          rawSeq: 2,
          activeMessagePosition: 1,
          effectiveParentId: null,
        },
      },
    };
    boundary.reports.mockResolvedValue([
      ...f.events,
      { ...f.events[0], id: "unrelated-report", details: unrelated },
    ]);
    const current = await readConversationKnowledgeRoot({
      ...f,
      assertCurrent: () => f.reader.assertCurrent(),
    });
    originalCurrent = false;
    expect(() =>
      assertNativeKnowledgeRootContribution(current.evidence, f.branch, unrelated),
    ).not.toThrow();
    const before = f.cohorts();
    const rebound = prepareConversationKnowledgeRootSubset({
      evidence: current.evidence,
      branch: f.branch,
      manifest: subset.manifest,
    });
    expect(rebound.manifest).toBe(subset.manifest);
    expect(rebound.scopeKey).toBe(subset.scopeKey);
    expect(() =>
      assertNativeKnowledgeRootContributionGroup(rebound.evidence, f.branch, proof),
    ).not.toThrow();
    expect(f.cohorts()).toBe(before);
    f.releaseReader();
    expect(() =>
      assertNativeKnowledgeRootContributionGroup(rebound.evidence, f.branch, proof),
    ).toThrow("released");
  });

  it("refuses forged or no-longer-current subset references, physical owners and recipient scopes", async () => {
    const f = fixture();
    const original = await readConversationKnowledgeRoot({ ...f, assertCurrent() {} });
    const subset = prepareConversationKnowledgeRootSubset({
      evidence: original.evidence,
      branch: f.branch,
      references: [f.receipt],
      maxBytes: 4096,
    });
    const rebind = (evidence = original.evidence) =>
      prepareConversationKnowledgeRootSubset({
        evidence,
        branch: f.branch,
        manifest: subset.manifest,
      });
    expect(() => rebind(Object.create(Object.getPrototypeOf(original.evidence!)))).toThrow(
      "native root evidence",
    );
    expect(() =>
      prepareConversationKnowledgeRootSubset({
        evidence: original.evidence,
        branch: f.branch,
        manifest: Object.create(Object.getPrototypeOf(subset.manifest)),
      }),
    ).toThrow("native candidate manifest");
    expect(() =>
      prepareConversationKnowledgeRootSubset({
        evidence: original.evidence,
        branch: { ...f.branch, sessionId: "other-recipient" },
        manifest: subset.manifest,
      }),
    ).toThrow("recipient changed");
    boundary.reports.mockResolvedValue([]);
    expect(() =>
      prepareConversationKnowledgeRootSubset({
        evidence: undefined,
        branch: f.branch,
        manifest: subset.manifest,
      }),
    ).toThrow("native root evidence");
    const retired = await readConversationKnowledgeRoot({ ...f, assertCurrent() {} });
    expect(() => rebind(retired.evidence)).toThrow("changed or retired");
    boundary.reports.mockResolvedValue(f.events);
    f.source.databaseIdentity = "replacement-native-owner";
    const replacement = await readConversationKnowledgeRoot({ ...f, assertCurrent() {} });
    expect(() => rebind(replacement.evidence)).toThrow("physical source");
  });
  it("shares an exact immutable checkpoint scope while retaining native recipient custody", async () => {
    const f = fixture();
    const references = Array.from({ length: 33 }, (_, index) => ({
      ...f.receipt,
      through: { ...f.receipt.through, entryId: `answer-${index}`, rawSeq: index + 3 },
    }));
    boundary.reports.mockResolvedValue(
      references.map((details, index) => ({ ...f.events[0], id: `root-${index}`, details })),
    );
    const root = await readConversationKnowledgeRoot({ ...f, assertCurrent() {} });
    expect(() =>
      issuePreparedKnowledgeRootCandidates(root.evidence, references, { maxBytes: 2_048 }),
    ).toThrow(RangeError);
    const manifest = issuePreparedKnowledgeRootCandidates(root.evidence, references, {
      maxBytes: 2_048,
      sharedMetadata: true,
    });
    expect(manifest.byteLength).toBeGreaterThan(2_048);
    expect(manifest.ownedByteLength).toBeLessThan(2_048);
    const first = await readPreparedConversationKnowledgeRoot({
      ...f,
      manifest,
      assertCurrent() {},
    });
    const proof = prepareNativeKnowledgeRootContributionGroup(first.evidence, f.branch, references);
    const secondManifest = issuePreparedKnowledgeRootCandidates(root.evidence, references, {
      maxBytes: 2_048,
      sharedMetadata: true,
    });
    const second = await readPreparedConversationKnowledgeRoot({
      ...f,
      manifest: secondManifest,
      assertCurrent() {},
    });
    expect(second[0]).toBe(first[0]);
    expect(Object.isFrozen(second[0])).toBe(true);
    expect(() =>
      assertNativeKnowledgeRootContributionGroup(second.evidence, f.branch, proof),
    ).not.toThrow();
    const audienceKey = conversationKnowledgeParticipantIdentity(
      f.receipt.privateAudience!.participant,
    )!;
    const checkpoint = createConversationKnowledgeCheckpoint({
      branch: f.branch,
      audienceKey,
      covered: references,
      summary: "Synthetic shared summary.",
    });
    const coverage = prepareConversationKnowledgeCheckpointCoverage({
      checkpoint,
      records: [checkpoint],
      assertCurrent() {},
    });
    const selection = prepareConversationKnowledgeCheckpointSelection({
      branch: f.branch,
      checkpoint,
      coverage,
      audienceKey,
      manifest,
      rootEvidence: first.evidence!,
      availableReferences: references,
      source() {},
    })!;
    expect(selection).toBeDefined();
    const enumerate = vi
      .spyOn(PreparedConversationKnowledgeCheckpointCoverage.prototype, "contributionIds")
      .mockImplementation(() => {
        throw new Error("ready enumerated historical membership");
      });
    const rehash = vi
      .spyOn(PreparedConversationKnowledgeCheckpointCoverage.prototype, "matchesReference")
      .mockImplementation(() => {
        throw new Error("ready rehashed historical references");
      });
    try {
      const readyEvidence = await readPreparedConversationKnowledgeRootEvidence({
        ...f,
        manifest,
        assertCurrent() {},
      });
      expect(Array.isArray(readyEvidence)).toBe(false);
      const binding = {
        branch: f.branch,
        checkpoint: selection.checkpoint,
        coverage,
        audienceKey,
        manifest,
        rootEvidence: readyEvidence,
      };
      expect(selection.validate(binding)).toBe(selection.checkpoint);
      expect(() => selection.validate({ ...binding, checkpoint })).toThrow("selection changed");
      expect(() => selection.validate({ ...binding, audienceKey: "different-person" })).toThrow(
        "selection changed",
      );
      expect(enumerate).not.toHaveBeenCalled();
      expect(rehash).not.toHaveBeenCalled();
    } finally {
      enumerate.mockRestore();
      rehash.mockRestore();
    }
    const subset = issuePreparedKnowledgeRootCandidates(root.evidence, references.slice(1), {
      maxBytes: 2_048,
      sharedMetadata: true,
    });
    const different = await readPreparedConversationKnowledgeRoot({
      ...f,
      manifest: subset,
      assertCurrent() {},
    });
    expect(() =>
      assertNativeKnowledgeRootContributionGroup(different.evidence, f.branch, proof),
    ).toThrow("root changed");
    f.releaseReader();
    expect(() =>
      assertNativeKnowledgeRootContributionGroup(second.evidence, f.branch, proof),
    ).toThrow("released");
  });
  it("prepares more than one SQL batch of exact references within its byte budget", async () => {
    const f = fixture();
    const references = Array.from({ length: 33 }, (_, index) => ({
      ...f.receipt,
      through: { ...f.receipt.through, entryId: `answer-${index}`, rawSeq: index + 3 },
    }));
    boundary.reports.mockResolvedValue(
      references.map((details, index) => ({ ...f.events[0], id: `root-${index}`, details })),
    );
    const root = await readConversationKnowledgeRoot({ ...f, assertCurrent() {} });
    const manifest = issuePreparedKnowledgeRootCandidates(root.evidence, references, {
      maxBytes: 128_000,
    });
    const rebound = await readPreparedConversationKnowledgeRoot({
      ...f,
      manifest,
      assertCurrent() {},
    });
    expect(rebound).toHaveLength(33);
    assertNativeKnowledgeRootContribution(rebound.evidence, f.branch, references[32]!);
    expect(() =>
      issuePreparedKnowledgeRootCandidates(root.evidence, references, {
        maxBytes: manifest.byteLength - 1,
      }),
    ).toThrow(RangeError);
  });

  it("accounts for an actual manifest while evicting raw bytes and preserves pending packets", async () => {
    const f = fixture();
    const root = await readConversationKnowledgeRoot({ ...f, assertCurrent() {} });
    const manifest = issuePreparedKnowledgeRootCandidates(root.evidence, [f.receipt], {
      maxBytes: 32_000,
    });
    expect(() =>
      createConversationKnowledgeSourceCache(manifest.byteLength - 1).setPreparedRoot(manifest),
    ).toThrow("cache budget");
    const cache = createConversationKnowledgeSourceCache(manifest.byteLength + 1_024);
    const version = { generation: f.receipt.through.generation, rawSeq: 3, updatedAt: 1 };
    const context = (text: string): SessionTranscriptModelContext => ({
      version,
      events: [{ type: "message", message: { role: "user", content: text } }],
    });
    const read = (id: string, text: string) =>
      cache.read({
        contributionId: id,
        target: { ...f.receipt.source, storePath: f.branch.storePath },
        through: f.receipt.through,
        assertCurrent() {},
        load: async () => context(text),
      });
    await read("original-raw", "r".repeat(manifest.byteLength));
    expect(cache.hasContribution("original-raw")).toBe(true);
    expect(
      cache.stage("pending", 0, {
        part: {
          origin: f.receipt.origin,
          text: "A pending observation.",
          complete: true,
          nextOffset: undefined,
          frontier: undefined,
        },
        version,
        through: f.receipt.through,
      }),
    ).toBe(true);
    const pending = cache.peek("pending", 0);
    cache.setPreparedRoot(manifest);
    expect(cache.preparedRoot).toBe(manifest);
    expect(cache.hasContribution("original-raw")).toBe(false);
    for (let index = 0; index < 3; index++) {
      await read(`next-raw-${index}`, "n".repeat(600));
    }
    expect(cache.hasContribution("next-raw-0")).toBe(false);
    expect(cache.hasContribution("next-raw-2")).toBe(true);
    expect(cache.preparedRoot).toBe(manifest);
    expect(cache.peek("pending", 0)).toEqual(pending);
    // No raw entries exist here: an eviction cannot accidentally satisfy the
    // revision assertion. A boundary may have observed the staged-only state.
    const readiness = createConversationKnowledgeSourceCache(manifest.byteLength);
    expect(readiness.stage("pending", 0, pending!)).toBe(true);
    expect(readiness.preparedRoot).toBeUndefined();
    const stagedRevision = readiness.revision;
    readiness.setPreparedRoot(manifest);
    expect(readiness.revision).toBeGreaterThan(stagedRevision);
    readiness.clear();
    cache.clear();
    expect(cache.preparedRoot).toBeUndefined();
    expect(cache.hasContribution("next-raw-2")).toBe(false);
    expect(cache.peek("pending", 0)).toBeUndefined();
  });

  it("rebinds immutable exact provenance after background release with one fresh cohort read", async () => {
    const f = fixture();
    let backgroundCurrent = true;
    const root = await readConversationKnowledgeRoot({
      ...f,
      assertCurrent: () => {
        if (!backgroundCurrent) {
          throw new Error("Background reader released");
        }
      },
    });
    const manifest = issuePreparedKnowledgeRootCandidates(root.evidence, [f.receipt], {
      maxBytes: 32_000,
    });
    expect(manifest.byteLength).toBeGreaterThan(Buffer.byteLength(JSON.stringify(f.events)));
    expect(Reflect.set(manifest, "byteLength", 0)).toBe(false);
    backgroundCurrent = false;
    expect(() => assertNativeKnowledgeRootContribution(root.evidence, f.branch, f.receipt)).toThrow(
      "Background reader released",
    );
    expect(() =>
      issuePreparedKnowledgeRootCandidates(root.evidence, [f.receipt], { maxBytes: 32_000 }),
    ).toThrow("Background reader released");
    const before = f.cohorts();
    let foregroundCurrent = true;
    const current = await readPreparedConversationKnowledgeRoot({
      ...f,
      manifest,
      assertCurrent: () => {
        if (!foregroundCurrent) {
          throw new Error("Foreground input revoked");
        }
      },
    });
    expect(f.cohorts() - before).toBe(1);
    expect(boundary.reports).toHaveBeenCalledTimes(1);
    expect(current).toEqual(f.events);
    expect(() =>
      assertNativeKnowledgeRootContribution(current.evidence, f.branch, f.receipt),
    ).not.toThrow();
    foregroundCurrent = false;
    expect(() =>
      assertNativeKnowledgeRootContribution(current.evidence, f.branch, f.receipt),
    ).toThrow("Foreground input revoked");
  });

  it("rejects forged brands, changed reference fields and over-budget candidate manifests", async () => {
    const f = fixture();
    const root = await readConversationKnowledgeRoot({ ...f, assertCurrent() {} });
    for (const evidence of [{}, structuredClone(root.evidence), Object.create(root.evidence!)]) {
      expect(() =>
        issuePreparedKnowledgeRootCandidates(evidence, [f.receipt], { maxBytes: 32_000 }),
      ).toThrow("native root evidence");
    }
    expect(() =>
      issuePreparedKnowledgeRootCandidates(
        root.evidence,
        [{ ...f.receipt, sourceMode: "native" }],
        { maxBytes: 32_000 },
      ),
    ).toThrow("matching native root evidence");
    for (const maxBytes of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() =>
        issuePreparedKnowledgeRootCandidates(root.evidence, [f.receipt], { maxBytes }),
      ).toThrow(RangeError);
    }
    const manifest = issuePreparedKnowledgeRootCandidates(root.evidence, [f.receipt], {
      maxBytes: 32_000,
    });
    for (const forged of [{}, structuredClone(manifest), Object.create(manifest)]) {
      await expect(
        readPreparedConversationKnowledgeRoot({
          ...f,
          assertCurrent() {},
          manifest: forged as PreparedKnowledgeRootCandidates,
        }),
      ).rejects.toThrow("native candidate manifest");
    }
  });

  it("does not borrow mutable report objects or treat root report removal as an access revocation", async () => {
    const f = fixture();
    const root = await readConversationKnowledgeRoot({ ...f, assertCurrent() {} });
    const manifest = issuePreparedKnowledgeRootCandidates(root.evidence, [f.receipt], {
      maxBytes: 32_000,
    });
    f.events.length = 0;
    const current = await readPreparedConversationKnowledgeRoot({
      ...f,
      manifest,
      assertCurrent() {},
    });
    expect(current).toHaveLength(1);
    expect(() =>
      assertNativeKnowledgeRootContribution(current.evidence, f.branch, f.receipt),
    ).not.toThrow();
    expect(boundary.reports).toHaveBeenCalledTimes(1);
  });

  it.each(["identity", "birthtime"] as const)(
    "refuses a replaced physical source (%s)",
    async (change) => {
      const f = fixture();
      const root = await readConversationKnowledgeRoot({ ...f, assertCurrent() {} });
      const manifest = issuePreparedKnowledgeRootCandidates(root.evidence, [f.receipt], {
        maxBytes: 32_000,
      });
      if (change === "identity") {
        f.source.databaseIdentity = "physical-replacement";
      } else {
        f.source.databaseBirthtime = "replacement-birthtime";
      }
      await expect(
        readPreparedConversationKnowledgeRoot({ ...f, manifest, assertCurrent() {} }),
      ).rejects.toThrow("physical source changed");
    },
  );

  it("refuses changed root/recipient lifecycle and current read authority", async () => {
    const f = fixture();
    const root = await readConversationKnowledgeRoot({ ...f, assertCurrent() {} });
    const manifest = issuePreparedKnowledgeRootCandidates(root.evidence, [f.receipt], {
      maxBytes: 32_000,
    });
    await expect(
      readPreparedConversationKnowledgeRoot({
        ...f,
        manifest,
        assertCurrent() {},
        branch: { ...f.branch, lifecycleRevision: "new-recipient" },
      }),
    ).rejects.toThrow("root or recipient changed");
    f.rootEntry.lifecycleRevision = "root-replacement";
    await expect(
      readPreparedConversationKnowledgeRoot({ ...f, manifest, assertCurrent() {} }),
    ).rejects.toThrow("root changed");
    f.rootEntry.lifecycleRevision = f.branch.root.lifecycleRevision;
    f.releaseReader();
    await expect(
      readPreparedConversationKnowledgeRoot({ ...f, manifest, assertCurrent() {} }),
    ).rejects.toThrow("Native reader released");
  });
});
