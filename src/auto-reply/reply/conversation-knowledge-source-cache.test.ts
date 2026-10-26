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
});
