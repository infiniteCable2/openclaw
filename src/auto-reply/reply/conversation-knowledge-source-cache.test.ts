import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTranscriptRuntimeScope } from "../../config/sessions/session-accessor.types.js";
import type { SessionTranscriptModelContext } from "../../config/sessions/session-history-read.types.js";
import type { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createConversationKnowledgeSourceCache,
  type PreparedConversationKnowledgePacket,
} from "./conversation-knowledge-source-cache.js";

const boundary = vi.hoisted(() => ({
  read: vi.fn<typeof readSessionTranscriptAnchorsAsync>(),
}));
// mock-isolation: Exercise cache lifetime and fresh native proof without opening databases or workers.
vi.mock("../../config/sessions/session-transcript-anchor-read.js", () => ({
  readSessionTranscriptAnchorsAsync: boundary.read,
}));

const target = {
  agentId: "example",
  storePath: "/synthetic/agent.sqlite",
  sessionKey: "agent:example:source",
  sessionId: "source-session",
};
const through: TranscriptEntryAnchor = {
  ...target,
  generation: "source-generation",
  entryId: "source-answer",
  rawSeq: 3,
  effectiveParentId: "source-question",
  activeMessagePosition: 2,
};
const from: TranscriptEntryAnchor = {
  ...through,
  entryId: "source-question",
  rawSeq: 2,
  effectiveParentId: null,
  activeMessagePosition: 1,
};
const version = { generation: through.generation, rawSeq: 3, updatedAt: 10 };
function context(text = "Source observation."): SessionTranscriptModelContext {
  return { events: [{ type: "message", message: { role: "user", content: text } }], version };
}
function packet(text = "A prepared observation."): PreparedConversationKnowledgePacket {
  return {
    part: {
      origin: "source-origin",
      text,
      complete: true,
      nextOffset: undefined,
      frontier: {
        origin: "source-origin",
        generation: through.generation,
        throughRawSeq: through.rawSeq,
        throughEntryId: through.entryId,
      },
    },
    version,
    through,
    from,
  };
}
const input = () => ({
  contributionId: "source-contribution",
  target,
  through,
  from,
  assertCurrent: vi.fn(),
});

beforeEach(() => {
  boundary.read.mockReset();
  boundary.read.mockImplementation(async (_target, _selection, _signal, consume) => {
    const facts = { anchors: [], contextValidated: true as const };
    consume?.(facts);
    return facts;
  });
});

describe("disposable conversation source preparation", () => {
  it("reports retired preparation independently of successful consumption in the same quantum", () => {
    const cache = createConversationKnowledgeSourceCache();
    cache.stage("retired", 0, packet());
    cache.stage("consumed", 0, packet());
    const invalidation = cache.invalidationRevision;
    const consumption = cache.consumptionRevision;
    cache.invalidateContribution("retired");
    cache.consume("consumed", 0);
    expect(cache.invalidationRevision).toBeGreaterThan(invalidation);
    expect(cache.consumptionRevision).toBeGreaterThan(consumption);
    const settled = cache.invalidationRevision;
    cache.invalidateContribution("absent");
    expect(cache.invalidationRevision).toBe(settled);
    cache.clear();
  });

  it("shares exact-manifest groups across consumed prefixes and releases the final pending original", () => {
    const cache = createConversationKnowledgeSourceCache(4_096);
    const source = { ...target, lifecycleRevision: "source-life" };
    const manifest = { byteLength: 64 } as Parameters<typeof cache.setPreparedRoot>[0];
    const next = { byteLength: 64 } as Parameters<typeof cache.setPreparedRoot>[0];
    const groupRelease = vi.fn();
    const group = { byteLength: 64, release: groupRelease } as unknown as Parameters<
      typeof cache.retainContributionGroup
    >[2];
    cache.setPreparedRoot(manifest, "canonical-selection");
    cache.stage("first", 0, packet());
    cache.stage("second", 0, packet());
    expect(cache.retainContributionGroup(["first", "second"], source, group, manifest)).toBe(true);
    expect(cache.preparedAdmission(source)).toBeUndefined();
    expect(cache.preparedContributionGroup(source, manifest, "foreign")).toBeUndefined();
    cache.consume("first", 0);
    expect(cache.setPreparedRoot(next, "canonical-selection")).toBe(manifest);
    expect(cache.preparedContributionGroup(source, manifest, "second")).toBe(group);
    expect(cache.preparedContributionGroup(source, next)).toBeUndefined();
    expect(groupRelease).not.toHaveBeenCalled();
    cache.consume("second", 0);
    expect(groupRelease).toHaveBeenCalledOnce();
    expect(cache.preparedContributionGroup(source, manifest)).toBeUndefined();
    cache.clear();
    expect(groupRelease).toHaveBeenCalledOnce();
  });
  it("retires replaced manifest groups without deleting pending bytes or unrelated single custody", () => {
    const cache = createConversationKnowledgeSourceCache(4_096);
    const source = { ...target, lifecycleRevision: "source-life" };
    const other = { ...source, sessionId: "other-source" };
    const manifest = { byteLength: 64 } as Parameters<typeof cache.setPreparedRoot>[0];
    const next = { byteLength: 64 } as Parameters<typeof cache.setPreparedRoot>[0];
    const groupRelease = vi.fn();
    const group = { byteLength: 64, release: groupRelease } as unknown as Parameters<
      typeof cache.retainContributionGroup
    >[2];
    const singleRelease = vi.fn();
    const single = { byteLength: 64, release: singleRelease } as unknown as Parameters<
      typeof cache.retainAdmission
    >[2];
    cache.setPreparedRoot(manifest, "old-selection");
    cache.stage("first", 0, packet());
    cache.retainContributionGroup(["first"], source, group, manifest);
    cache.retainAdmission("other", other, single);
    cache.setPreparedRoot(next, "new-selection");
    expect(groupRelease).toHaveBeenCalledOnce();
    expect(cache.peek("first", 0)).toEqual(packet());
    expect(cache.preparedContributionGroup(source, manifest)).toBeUndefined();
    expect(cache.preparedAdmission(other)).toBe(single);
    cache.clear();
    expect(singleRelease).toHaveBeenCalledOnce();
  });
  it("replaces exact group associations and retires custody covered by an adopted checkpoint", () => {
    const cache = createConversationKnowledgeSourceCache(4_096);
    const source = { ...target, lifecycleRevision: "source-life" };
    const manifest = { byteLength: 64, ownedByteLength: 64 } as Parameters<
      typeof cache.setPreparedRoot
    >[0];
    const firstRelease = vi.fn();
    const first = { byteLength: 64, release: firstRelease } as unknown as Parameters<
      typeof cache.retainContributionGroup
    >[2];
    const secondRelease = vi.fn();
    const second = { byteLength: 64, release: secondRelease } as unknown as typeof first;
    cache.setPreparedRoot(manifest, "selection");
    cache.stage("first", 0, packet());
    cache.stage("second", 0, packet());
    cache.retainContributionGroup(["first", "second"], source, first, manifest);
    cache.retainContributionGroup(["second"], source, second, manifest);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(cache.preparedContributionGroup(source, manifest, "first")).toBeUndefined();
    expect(cache.preparedContributionGroup(source, manifest, "second")).toBe(second);
    const checkpoint = {
      manifest,
      checkpoint: { checkpointId: "synthetic-checkpoint", summary: "Both originals are covered." },
      groups: [],
      coverage: { has: () => true },
    } as unknown as Parameters<typeof cache.stageCheckpoint>[0];
    expect(cache.stageCheckpoint(checkpoint)).toBe(true);
    cache.consumeCheckpoint(checkpoint);
    expect(cache.preparedPackets(2)).toHaveLength(0);
    expect(secondRelease).toHaveBeenCalledOnce();
    expect(cache.preparedContributionGroup(source, manifest)).toBeUndefined();
    cache.clear();
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).toHaveBeenCalledOnce();
  });
  it("fails closed before retrying group release and rejects over-budget or unrelated manifests", () => {
    const cache = createConversationKnowledgeSourceCache(128);
    const source = { ...target, lifecycleRevision: "source-life" };
    const manifest = { byteLength: 64 } as Parameters<typeof cache.setPreparedRoot>[0];
    const groupRelease = vi.fn().mockImplementationOnce(() => {
      throw new Error("Native group cleanup pending");
    });
    const group = { byteLength: 64, release: groupRelease } as unknown as Parameters<
      typeof cache.retainContributionGroup
    >[2];
    cache.setPreparedRoot(manifest, "selection");
    cache.retainContributionGroup(["first"], source, group, manifest);
    expect(() => cache.clearPreparedRoot(manifest)).toThrow("cleanup remains pending");
    expect(cache.preparedRoot).toBeUndefined();
    expect(cache.preparedContributionGroup(source, manifest)).toBeUndefined();
    cache.retryCleanup();
    expect(groupRelease).toHaveBeenCalledTimes(2);
    const refusedRelease = vi.fn();
    const refused = { byteLength: 129, release: refusedRelease } as unknown as Parameters<
      typeof cache.retainContributionGroup
    >[2];
    cache.setPreparedRoot(manifest, "selection");
    expect(cache.retainContributionGroup(["first"], source, refused, manifest)).toBe(false);
    expect(refusedRelease).toHaveBeenCalledOnce();
    const unrelated = { byteLength: 1 } as Parameters<typeof cache.setPreparedRoot>[0];
    expect(cache.retainContributionGroup(["first"], source, refused, unrelated)).toBe(false);
    expect(refusedRelease).toHaveBeenCalledTimes(2);
    cache.clear();
  });
  it("charges checkpoint-owned custody and summary bytes, not shared root metadata", () => {
    const cache = createConversationKnowledgeSourceCache(256);
    const candidate = {
      manifest: { byteLength: 10_000_000, ownedByteLength: 32 },
      checkpoint: { summary: "Small summary" },
      groups: [{ admission: { byteLength: 10_000_000, ownedByteLength: 32, release: vi.fn() } }],
    } as unknown as Parameters<typeof cache.stageCheckpoint>[0];
    expect(cache.stageCheckpoint(candidate)).toBe(true);
    cache.clearCheckpoint();
    expect(
      cache.stageCheckpoint({
        ...candidate,
        checkpoint: { ...candidate.checkpoint, summary: "x".repeat(256) },
      }),
    ).toBe(false);
    expect(cache.preparedCheckpoint).toBeUndefined();
  });
  it("reports only bounded content-free complete prepared source frontiers", () => {
    const cache = createConversationKnowledgeSourceCache();
    for (let index = 0; index < 10; index++) {
      cache.stage(`item-${index}`, 0, {
        ...packet(),
        through: { ...through, sessionId: `source-${index}`, rawSeq: index + 3 },
      });
    }
    cache.stage("later", 0, {
      ...packet(),
      through: { ...through, sessionId: "source-0", rawSeq: 25 },
    });
    cache.stage("partial", 0, {
      ...packet(),
      part: { ...packet().part, complete: false },
      through: { ...through, sessionId: "partial-source" },
    });
    const diagnostics = cache.diagnosticPreparedFrontiers();
    expect(diagnostics).toHaveLength(8);
    expect(diagnostics[0]).toEqual({ sourceHash: redactIdentifier("source-0"), throughSeq: 25 });
    expect(JSON.stringify(diagnostics)).not.toContain("Source observation");
    expect(JSON.stringify(diagnostics)).not.toContain("partial-source");
  });
  it("retires all checkpoint groups and retains failed native cleanup for retry", () => {
    const cache = createConversationKnowledgeSourceCache();
    const first = vi.fn().mockImplementationOnce(() => {
      throw new Error("cleanup busy");
    });
    const second = vi.fn();
    const candidate = {
      manifest: { byteLength: 10, ownedByteLength: 10 },
      checkpoint: { summary: "Synthetic summary" },
      groups: [first, second].map((release) => ({
        admission: { byteLength: 10, ownedByteLength: 10, release },
      })),
    } as unknown as Parameters<typeof cache.stageCheckpoint>[0];
    expect(cache.stageCheckpoint(candidate)).toBe(true);
    expect(() => cache.clearCheckpoint()).toThrow("cleanup remains pending");
    expect(cache.preparedCheckpoint).toBeUndefined();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    cache.retryCleanup();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledOnce();
  });
  it("shares bounded native custody across one donor's pending packets", () => {
    const cache = createConversationKnowledgeSourceCache<{ byteLength: number; release(): void }>(
      128,
    );
    const source = { ...target, lifecycleRevision: "source-life" };
    const admission = { byteLength: 64, release: vi.fn() };
    const duplicate = { byteLength: 64, release: vi.fn() };
    expect(cache.retainAdmission("first", source, admission)).toBe(true);
    expect(cache.retainAdmission("second", source, duplicate)).toBe(true);
    expect(duplicate.release).toHaveBeenCalledOnce();
    expect(cache.preparedAdmission(source)).toBe(admission);
    cache.invalidateContribution("first");
    expect(admission.release).not.toHaveBeenCalled();
    cache.invalidateContribution("second");
    expect(admission.release).toHaveBeenCalledOnce();
    expect(cache.preparedAdmission(source)).toBeUndefined();
    cache.clear();
    expect(admission.release).toHaveBeenCalledOnce();
  });

  it("revokes every cached preparation before retrying failed cleanup", () => {
    const cache = createConversationKnowledgeSourceCache<{ byteLength: number; release(): void }>();
    const source = { ...target, lifecycleRevision: "source-life" };
    const first = {
      byteLength: 64,
      release: vi.fn().mockImplementationOnce(() => {
        throw new Error("Native cleanup unavailable");
      }),
    };
    const second = { byteLength: 64, release: vi.fn() };
    const other = { ...source, sessionId: "another-source" };
    cache.retainAdmission("first", source, first);
    cache.retainAdmission("second", other, second);
    expect(() => cache.clear()).toThrow("cleanup remains pending");
    expect(cache.preparedAdmission(source)).toBeUndefined();
    expect(cache.preparedAdmission(other)).toBeUndefined();
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).toHaveBeenCalledOnce();
    cache.clear();
    expect(first.release).toHaveBeenCalledTimes(2);
    expect(second.release).toHaveBeenCalledOnce();
  });

  it("keeps native preparation bounded independently of pending text", () => {
    const cache = createConversationKnowledgeSourceCache<{ byteLength: number; release(): void }>(
      64,
    );
    const source = { ...target, lifecycleRevision: "source-life" };
    const admission = { byteLength: 64, release: vi.fn() };
    const refused = { byteLength: 1, release: vi.fn() };
    expect(cache.retainAdmission("first", source, admission)).toBe(true);
    expect(cache.retainAdmission("other", { ...source, sessionId: "another" }, refused)).toBe(
      false,
    );
    expect(refused.release).toHaveBeenCalledOnce();
    cache.retainContributions(new Set());
    expect(admission.release).toHaveBeenCalledOnce();
  });

  it("releases the native preparation only after the final staged segment", () => {
    const cache = createConversationKnowledgeSourceCache<{ byteLength: number; release(): void }>();
    const source = { ...target, lifecycleRevision: "source-life" };
    const admission = { byteLength: 64, release: vi.fn() };
    expect(
      cache.stage("source", 0, {
        ...packet(),
        part: { ...packet().part, complete: false, nextOffset: 1 },
      }),
    ).toBe(true);
    expect(cache.stage("source", 1, packet())).toBe(true);
    expect(cache.retainAdmission("source", source, admission)).toBe(true);
    cache.consume("source", 0);
    expect(admission.release).not.toHaveBeenCalled();
    cache.consume("source", 1);
    expect(admission.release).toHaveBeenCalledOnce();
  });

  it("drops invalid native custody without acknowledging prepared source text", () => {
    const cache = createConversationKnowledgeSourceCache<{ byteLength: number; release(): void }>();
    const source = { ...target, lifecycleRevision: "source-life" };
    const admission = { byteLength: 64, release: vi.fn() };
    const replacement = { byteLength: 64, release: vi.fn() };
    cache.stage("source", 0, packet());
    cache.retainAdmission("source", source, admission);
    cache.invalidateAdmission(source);
    expect(admission.release).toHaveBeenCalledOnce();
    expect(cache.preparedAdmission(source)).toBeUndefined();
    expect(cache.peek("source", 0)).toEqual(packet());
    cache.retainAdmission("source", source, replacement);
    cache.clear();
    expect(admission.release).toHaveBeenCalledOnce();
    expect(replacement.release).toHaveBeenCalledOnce();
  });

  it("retains unsuccessful checkpoint cleanup until background retry or clear succeeds", () => {
    const cache = createConversationKnowledgeSourceCache();
    const failed = vi.fn().mockImplementationOnce(() => {
      throw new Error("temporary");
    });
    const other = vi.fn();
    cache.retainCleanup(failed);
    cache.retainCleanup(other);
    expect(() => cache.retryCleanup()).toThrow("cleanup remains pending");
    expect(other).toHaveBeenCalledOnce();
    cache.clear();
    expect(failed).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledOnce();
    cache.clear();
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it("reuses bytes only after fresh native range proof and the current caller's checks", async () => {
    const cache = createConversationKnowledgeSourceCache();
    const load = vi.fn(async () => context());
    const original = await cache.read({ ...input(), load });
    const revision = cache.revision;
    const next = input();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    boundary.read.mockImplementationOnce(async (_target, selection, _signal, consume) => {
      expect(selection.contextValidation).toEqual({ version, through, from });
      entered.resolve();
      await release.promise;
      const facts = { anchors: [], contextValidated: true as const };
      consume?.(facts);
      return facts;
    });
    let settled = false;
    const pending = cache.read({ ...next, load }).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    expect(settled).toBe(false);
    release.resolve();
    expect(await pending).toEqual(original);
    expect(load).toHaveBeenCalledTimes(1);
    expect(next.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(cache.revision).toBe(revision);
  });

  it.each(["refused", "missing"])("reloads after %s native range proof", async (kind) => {
    const cache = createConversationKnowledgeSourceCache();
    const load = vi.fn(async () => context("Old observation."));
    await cache.read({ ...input(), load });
    const revision = cache.revision;
    if (kind === "refused") {
      boundary.read.mockRejectedValueOnce(new SessionTranscriptReadFenceError("source changed"));
    } else {
      boundary.read.mockResolvedValueOnce({ anchors: [] });
    }
    load.mockResolvedValueOnce(context("Freshly loaded observation."));
    expect(await cache.read({ ...input(), load })).toEqual(context("Freshly loaded observation."));
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.revision).toBeGreaterThan(revision);
  });

  it("does not retain the previous caller's authority or reload after revocation", async () => {
    const cache = createConversationKnowledgeSourceCache();
    const load = vi.fn(async () => context());
    await cache.read({ ...input(), load });
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("recipient revoked");
      }
    };
    boundary.read.mockImplementationOnce(async (_target, _selection, _signal, consume) => {
      current = false;
      const facts = { anchors: [], contextValidated: true as const };
      consume?.(facts);
      return facts;
    });
    await expect(cache.read({ ...input(), assertCurrent, load })).rejects.toThrow(
      "recipient revoked",
    );
    expect(load).toHaveBeenCalledTimes(1);
    await expect(cache.read({ ...input(), assertCurrent, load })).rejects.toThrow(
      "recipient revoked",
    );
    expect(boundary.read).toHaveBeenCalledTimes(1);
  });

  it("keeps cache-only misses and stale entries off the source-load path", async () => {
    const cache = createConversationKnowledgeSourceCache();
    expect(await cache.read(input())).toBeUndefined();
    expect(boundary.read).not.toHaveBeenCalled();
    await cache.read({ ...input(), load: async () => context() });
    boundary.read.mockRejectedValueOnce(new SessionTranscriptReadFenceError("source changed"));
    expect(await cache.read(input())).toBeUndefined();
    expect(cache.hasContribution("source-contribution")).toBe(false);
  });

  it("bounds raw reuse without dropping freshly loaded oversized knowledge", async () => {
    const cache = createConversationKnowledgeSourceCache(1);
    const value = context("A large observation must still reach its caller.");
    const load = vi.fn(async () => value);
    expect(await cache.read({ ...input(), load })).toEqual(value);
    expect(cache.hasContribution("source-contribution")).toBe(false);
    expect(await cache.read(input())).toBeUndefined();
    expect(await cache.read({ ...input(), load })).toEqual(value);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys physical coordinates, not incidental environment objects or target key ordering", async () => {
    const cache = createConversationKnowledgeSourceCache();
    const load = vi.fn(async () => context());
    // Native read scopes may carry environment facts; the cache owns only
    // their resolved physical coordinates, not that wider read configuration.
    const originalScope = {
      ...target,
      env: { EXAMPLE_ONLY: "first" },
    } satisfies SessionTranscriptRuntimeScope;
    const nextScope = {
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      agentId: target.agentId,
      env: { EXAMPLE_ONLY: "next" },
    } satisfies SessionTranscriptRuntimeScope;
    await cache.read({ ...input(), target: originalScope, load });
    await cache.read({ ...input(), target: nextScope, load });
    expect(load).toHaveBeenCalledTimes(1);
    expect(boundary.read).toHaveBeenCalledTimes(1);
    await cache.read({ ...input(), target: { ...target, sessionId: "replacement" }, load });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not refill or resurrect raw bytes after clear during an awaited operation", async () => {
    const cache = createConversationKnowledgeSourceCache();
    const loading = createDeferredCore<SessionTranscriptModelContext>();
    const pending = cache.read({ ...input(), load: () => loading.promise });
    cache.clear();
    loading.resolve(context());
    expect(await pending).toEqual(context());
    expect(cache.hasContribution("source-contribution")).toBe(false);
    await cache.read({ ...input(), load: async () => context() });
    boundary.read.mockImplementationOnce(async (_target, _selection, _signal, consume) => {
      cache.clear();
      const facts = { anchors: [], contextValidated: true as const };
      consume?.(facts);
      return facts;
    });
    expect(await cache.read(input())).toEqual(context());
    expect(cache.hasContribution("source-contribution")).toBe(false);
  });

  it("retains earlier staged packets under pressure, deduplicates, and protects staged bytes", () => {
    const value = packet();
    const size = Buffer.byteLength(JSON.stringify(value));
    const cache = createConversationKnowledgeSourceCache(size);
    expect(cache.stage("first", 0, value)).toBe(true);
    const revision = cache.revision;
    expect(cache.stage("first", 0, packet("A different duplicate must not overwrite."))).toBe(true);
    expect(cache.revision).toBe(revision);
    expect(cache.stage("next", 0, packet())).toBe(false);
    value.part.text = "Changed by the producer after staging.";
    const observed = cache.peek("first", 0)!;
    expect(observed.part.text).toBe("A prepared observation.");
    observed.part.text = "Changed by the recipient after reading.";
    expect(cache.peek("first", 0)?.part.text).toBe("A prepared observation.");
    expect(cache.hasContribution("first")).toBe(true);
    cache.consume("first", 1);
    expect(cache.revision).toBe(revision);
    cache.consume("first", 0);
    expect(cache.hasContribution("first")).toBe(false);
    expect(cache.stage("next", 0, packet())).toBe(true);
    cache.clear();
    expect(cache.peek("next", 0)).toBeUndefined();
    expect(cache.hasContribution("next")).toBe(false);
  });

  it("fences in-flight preparation on every consumption and clear, including absent slots", () => {
    const cache = createConversationKnowledgeSourceCache();
    expect(cache.consumptionRevision).toBe(0);
    cache.stage("source-contribution", 0, packet());
    expect(cache.consumptionRevision).toBe(0);
    cache.consume("source-contribution", 10);
    expect(cache.consumptionRevision).toBe(1);
    expect(cache.peek("source-contribution", 0)).toEqual(packet());
    cache.consume("source-contribution", 0);
    expect(cache.consumptionRevision).toBe(2);
    cache.consume("source-contribution", 0);
    expect(cache.consumptionRevision).toBe(3);
    cache.clear();
    expect(cache.consumptionRevision).toBe(4);
  });

  it("invalidates every raw range and staged offset of exactly one contribution", async () => {
    const cache = createConversationKnowledgeSourceCache();
    await cache.read({ ...input(), load: async () => context() });
    await cache.read({ ...input(), from: undefined, load: async () => context() });
    await cache.read({ ...input(), contributionId: "other", load: async () => context() });
    cache.stage("source-contribution", 0, packet());
    cache.stage("source-contribution", 10, packet());
    cache.stage("other", 0, packet());
    const revision = cache.revision;
    cache.invalidateContribution("source-contribution");
    expect(cache.revision).toBeGreaterThan(revision);
    expect(cache.hasContribution("source-contribution")).toBe(false);
    expect(cache.peek("source-contribution", 0)).toBeUndefined();
    expect(cache.peek("source-contribution", 10)).toBeUndefined();
    expect(await cache.read(input())).toBeUndefined();
    expect(await cache.read({ ...input(), from: undefined })).toBeUndefined();
    expect(cache.peek("other", 0)).toEqual(packet());
    expect(await cache.read({ ...input(), contributionId: "other" })).toEqual(context());
    const unchanged = cache.revision;
    cache.invalidateContribution("absent");
    expect(cache.revision).toBe(unchanged);
    // Earlier packet first-wins state cannot survive into a newly prepared range.
    expect(cache.stage("source-contribution", 10, packet("Newly prepared source range."))).toBe(
      true,
    );
    expect(cache.peek("source-contribution", 10)?.part.text).toBe("Newly prepared source range.");
  });

  it.each([0, 20])(
    "replaces a rewritten range at offset %s without its old continuation",
    (offset) => {
      const cache = createConversationKnowledgeSourceCache();
      cache.stage("source-contribution", 0, packet("Earlier source range."));
      cache.stage("source-contribution", 10, packet("Earlier source continuation."));
      cache.stage("other", 0, packet("Independent observation."));
      const renewed = packet("Revalidated source range.");
      renewed.through = { ...renewed.through, generation: "rewritten-generation" };
      renewed.version = { ...renewed.version, generation: "rewritten-generation" };
      expect(cache.stage("source-contribution", offset, renewed)).toBe(true);
      expect(cache.peek("source-contribution", offset)).toEqual(renewed);
      expect(cache.peek("source-contribution", 10)).toBeUndefined();
      if (offset !== 0) {
        expect(cache.peek("source-contribution", 0)).toBeUndefined();
      }
      expect(cache.peek("other", 0)?.part.text).toBe("Independent observation.");
    },
  );

  it("removes retired candidates so they cannot occupy every prepared manifest slot", async () => {
    const cache = createConversationKnowledgeSourceCache();
    await cache.read({ ...input(), load: async () => context() });
    for (let offset = 0; offset < 40; offset++) {
      cache.stage(`retired-${offset}`, 0, packet());
    }
    cache.stage("current", 0, packet("Current observation."));
    cache.retainContributions(new Set(["current"]));
    expect(cache.preparedContributionIds(32)).toEqual(["current"]);
    expect(cache.preparedPackets(32)).toEqual([{ contributionId: "current", offset: 0 }]);
    expect(cache.hasContribution("source-contribution")).toBe(false);
    expect(cache.peek("current", 0)?.part.text).toBe("Current observation.");
  });
});
