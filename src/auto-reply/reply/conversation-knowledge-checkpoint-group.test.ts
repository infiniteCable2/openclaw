import { beforeEach, expect, it, vi } from "vitest";
import type { PreparedKnowledgeRootCandidates } from "../../config/sessions/conversation-knowledge-store.js";
import {
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import { SessionMutationFactsUnavailableError } from "../../gateway/session-sharing-incognito.js";
import type { PreparedPersonalConversationContributionGroup } from "../../gateway/session-transcript-personal-read.js";
import {
  prepareCheckpointGroupCache,
  prepareCheckpointGroupRead,
} from "./conversation-knowledge-checkpoint-group.js";
import { createConversationKnowledgeSourceCache } from "./conversation-knowledge-source-cache.js";
import type { ConversationKnowledgeHeldSource } from "./conversation-knowledge-source-reader.js";

const native = vi.hoisted(() => ({
  group: vi.fn(),
  read: vi.fn(),
  subset: vi.fn(),
  publish: vi.fn(),
}));
// mock-isolation: Native subset branding and private grants are covered by storage scenarios.
vi.mock("../../config/sessions/conversation-knowledge-store.js", () => ({
  prepareConversationKnowledgeRootSubset: native.subset,
}));
// mock-isolation: Exercise cache ownership and current-scope renewal without opening worker databases.
vi.mock("../../gateway/session-transcript-personal-read.js", () => ({
  preparePersonalConversationContributionGroup: native.group,
  preparePersonalConversationRead: native.read,
}));
// mock-isolation: Observe bounded provenance publication separately from group lifetime.
vi.mock("./conversation-knowledge-source-reader.js", () => ({
  publishPreparedConversationKnowledgeRoot: native.publish,
}));

beforeEach(() => vi.resetAllMocks());

function fixture(maxBytes = 4096, groupBytes = 100) {
  const participant = { type: "profile" as const, id: "person-example" };
  const branch = {
    agentId: "example",
    storePath: "/synthetic/root.sqlite",
    sessionKey: "agent:example:broker",
    sessionId: "broker",
    lifecycleRevision: "broker-life",
    root: { sessionKey: "agent:example:root", sessionId: "root", lifecycleRevision: "root-life" },
  };
  const donor = {
    ...branch,
    sessionKey: "agent:example:donor",
    sessionId: "donor",
    lifecycleRevision: "donor-life",
  };
  const through = {
    ...donor,
    generation: "generation",
    rawSeq: 1,
    entryId: "original",
    activeMessagePosition: 0,
    effectiveParentId: null,
  };
  const reference: ConversationKnowledgeReference = {
    version: 1,
    sourceMode: "branches",
    kind: "utterance-observation",
    role: "user",
    source: donor,
    origin: conversationKnowledgeOrigin(donor, "utterance-observation"),
    through,
    privateAudience: { participant, admission: through },
  };
  const manifest = { byteLength: 40 } as PreparedKnowledgeRootCandidates;
  const subset = { byteLength: 20 } as PreparedKnowledgeRootCandidates;
  const cache = createConversationKnowledgeSourceCache(maxBytes);
  cache.setPreparedRoot(manifest, "root-first", {
    scopeKey: "physical-root-broker-person",
    sources: [{ source: donor, selectionKey: "donor-first" }],
  });
  native.subset.mockReturnValue({ manifest: subset, evidence: {} });
  const groups: PreparedPersonalConversationContributionGroup[] = [];
  const reads: ConversationKnowledgeHeldSource[] = [];
  const created: Array<{ release: ReturnType<typeof vi.fn>; byteLength: number }> = [];
  native.group.mockImplementation(async () => {
    const group = { release: vi.fn(), byteLength: groupBytes };
    created.push(group);
    return group;
  });
  native.read.mockImplementation(async (request) => {
    request.personal.assertCurrent();
    return { assertCurrent: request.personal.assertCurrent, release: vi.fn() };
  });
  const params = {
    branch,
    participant,
    audience: {
      ...branch,
      participant,
      channelId: "example",
      accountId: "default",
      nativeChannelId: "private",
      assertCurrent() {},
    },
    contributions: [reference],
    cache,
    manifest,
    signal: new AbortController().signal,
    assertCurrent() {},
    workCheck() {},
    getRuntimeConfig: () => ({}),
    groups,
    reads,
    drop(read: ConversationKnowledgeHeldSource) {
      read.grant.release();
      const index = reads.indexOf(read);
      if (index >= 0) {
        reads.splice(index, 1);
      }
    },
  };
  return { params, cache, donor, manifest, created, reads, groups };
}

it("reuses a descriptor after its previous quantum ends but derives a fresh current grant", async () => {
  const f = fixture();
  let original = true;
  const first = await prepareCheckpointGroupRead({
    ...f.params,
    assertCurrent() {
      if (!original) {
        throw new Error("Old quantum ended");
      }
    },
  });
  first.finish();
  f.params.drop(f.reads[0]!);
  original = false;
  const current = vi.fn();
  const second = await prepareCheckpointGroupRead({ ...f.params, assertCurrent: current });
  second.grant.assertCurrent();
  second.finish();
  expect(native.group).toHaveBeenCalledOnce();
  expect(native.read).toHaveBeenCalledTimes(2);
  expect(native.read.mock.calls[1]![0].personal.assertCurrent).toBe(current);
  expect(native.read.mock.calls[1]![0].personal.rootEvidence).toBe(
    native.subset.mock.results[1]!.value.evidence,
  );
  expect(f.groups).toHaveLength(0);
  expect(f.created[0]!.release).not.toHaveBeenCalled();
  f.params.drop(f.reads[0]!);
  f.cache.clear();
  expect(f.created[0]!.release).toHaveBeenCalledOnce();
});

it("renews stale native custody under today's source policy", async () => {
  const f = fixture();
  (await prepareCheckpointGroupRead(f.params)).finish();
  f.params.drop(f.reads[0]!);
  native.read.mockRejectedValueOnce(new SessionMutationFactsUnavailableError());
  const renewed = await prepareCheckpointGroupRead(f.params);
  renewed.finish();
  expect(native.group).toHaveBeenCalledTimes(2);
  expect(native.read).toHaveBeenCalledTimes(3);
  expect(f.created[0]!.release).toHaveBeenCalledOnce();
  expect(f.created[1]!.release).not.toHaveBeenCalled();
  f.params.drop(f.reads[0]!);
  f.cache.clear();
  expect(f.created[1]!.release).toHaveBeenCalledOnce();
});

it("does not let an older failed reuse retire a newer cached donor group", async () => {
  const f = fixture();
  (await prepareCheckpointGroupRead(f.params)).finish();
  f.params.drop(f.reads[0]!);
  const replacement = { byteLength: 100, release: vi.fn() };
  native.read.mockImplementationOnce(async () => {
    f.cache.retainContributionGroup(
      ["replacement"],
      f.donor,
      replacement as unknown as PreparedPersonalConversationContributionGroup,
      f.manifest,
    );
    throw new SessionMutationFactsUnavailableError();
  });
  await expect(prepareCheckpointGroupRead(f.params)).rejects.toBeInstanceOf(
    SessionTranscriptReadFenceError,
  );
  expect(f.cache.preparedContributionGroup(f.donor, f.manifest)).toBe(replacement);
  expect(replacement.release).not.toHaveBeenCalled();
  expect(native.group).toHaveBeenCalledOnce();
  f.cache.clear();
  expect(replacement.release).toHaveBeenCalledOnce();
});

it("keeps current native preparation usable when the bounded cache refuses admission", async () => {
  const f = fixture(200, 500);
  const prepared = await prepareCheckpointGroupRead(f.params);
  prepared.grant.assertCurrent();
  prepared.finish();
  expect(f.cache.preparedContributionGroup(f.donor, f.manifest)).toBeUndefined();
  expect(f.created[0]!.release).toHaveBeenCalledOnce();
  expect(f.groups).toHaveLength(0);
  expect(f.reads).toHaveLength(1);
  f.params.drop(f.reads[0]!);
  f.cache.clear();
  expect(f.created[0]!.release).toHaveBeenCalledOnce();
});

it("falls back to uncached native groups when root provenance exceeds cache capacity", async () => {
  const f = fixture();
  native.publish.mockImplementation(() => {
    throw new RangeError("Prepared provenance exceeds cache capacity");
  });
  const manifest = prepareCheckpointGroupCache({
    cache: f.cache,
    evidence: {} as never,
    branch: f.params.branch,
    references: f.params.contributions,
    audienceIdentity: "profile:person-example",
    workCheck() {},
  });
  expect(manifest).toBeUndefined();
  const prepared = await prepareCheckpointGroupRead({ ...f.params, manifest });
  prepared.grant.assertCurrent();
  prepared.finish();
  expect(f.created[0]!.release).toHaveBeenCalledOnce();
  expect(f.groups).toHaveLength(0);
  f.params.drop(f.reads[0]!);
  f.cache.clear();
});
