import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationKnowledgeContributionId } from "../../config/sessions/conversation-knowledge-identity.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import {
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SessionTranscriptModelContext } from "../../config/sessions/session-history-read.types.js";
import {
  prepareSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { PersonalConversationReadRefusedError } from "../../gateway/session-mutation-authorization-error.js";
import { SessionMutationFactsUnavailableError } from "../../gateway/session-sharing-incognito.js";
import { prepareConversationKnowledgeCheckpointSources } from "./conversation-knowledge-checkpoint-source.js";
import type { PreparedConversationKnowledgePacket } from "./conversation-knowledge-source-cache.js";

const boundary = vi.hoisted(() => ({
  target: vi.fn(),
  context: vi.fn(),
  anchors: vi.fn(),
  group: vi.fn(),
  personal: vi.fn(),
  targetRelease: vi.fn(),
  debug: vi.fn(),
}));
// mock-isolation: Supply native root provenance without opening storage or indexing histories.
vi.mock("../../config/sessions/conversation-knowledge-store.js", () => ({
  readConversationKnowledgeRoot: async () => [],
  assertNativeKnowledgeRootContribution() {},
}));
// mock-isolation: This suite owns checkpoint refusal handling, not foreign-source grant discovery.
vi.mock("./conversation-knowledge-source-reader.js", () => ({
  prepareConversationKnowledgeTarget: boundary.target,
  createConversationKnowledgeSourceReader: () => ({
    async take() {
      return {};
    },
  }),
}));
// mock-isolation: Inject canonical native anchor/read outcomes without starting SQLite workers.
vi.mock("../../config/sessions/session-transcript-context-read.js", () => ({
  readSessionTranscriptModelContextAsync: boundary.context,
}));
// mock-isolation: Exact validation decisions are supplied by this boundary's synthetic native reader.
vi.mock("../../config/sessions/session-transcript-anchor-read.js", () => ({
  readSessionTranscriptAnchorsAsync: boundary.anchors,
}));
// mock-isolation: Observe group cleanup when native personal admission refuses an exact saved range.
vi.mock("../../gateway/session-transcript-personal-read.js", () => ({
  preparePersonalConversationContributionGroup: boundary.group,
  preparePersonalConversationRead: boundary.personal,
}));
// mock-isolation: Verify content-free diagnostics without initializing process-wide log outputs.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug: boundary.debug }),
}));

const branch: ConversationKnowledgeBranch = {
  agentId: "example",
  sessionKey: "agent:example:chat",
  sessionId: "chat-instance",
  lifecycleRevision: "chat-life",
  storePath: "/synthetic/checkpoint-source.sqlite",
  root: {
    sessionKey: "agent:example:root",
    sessionId: "root-instance",
    lifecycleRevision: "root-life",
  },
};
const person = { type: "profile", id: "synthetic-person" } as const;
const nativeSource = {
  agentId: branch.agentId,
  path: branch.storePath,
  databaseIdentity: "native",
};
const config: OpenClawConfig = {
  agents: { entries: { example: { conversationMode: "branches" } } },
};
function reference(generation = "current"): ConversationKnowledgeReference {
  const source = {
    agentId: branch.agentId,
    sessionKey: branch.sessionKey,
    sessionId: branch.sessionId,
    lifecycleRevision: branch.lifecycleRevision,
  };
  const through = {
    ...source,
    storePath: branch.storePath,
    generation,
    entryId: "original-message",
    rawSeq: 1,
    activeMessagePosition: 0,
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
const cleanups = new Set<() => void>();
async function sources(
  assertCurrent = () => {},
  options?: {
    signal?: AbortSignal;
    authority?: { signal: AbortSignal; assertCurrent: () => void };
    onReadRequest?: (request: { sessionKeys: readonly string[] }) => void;
  },
) {
  const reader: SessionEntryCohortReader = {
    database: { agentId: branch.agentId, path: branch.storePath, env: {} },
    logicalAgentId: branch.agentId,
    storePaths: [branch.storePath],
    sessionKey: branch.sessionKey,
    assertCurrent: options?.authority?.assertCurrent ?? assertCurrent,
    async withRead(request, check, consume) {
      options?.onReadRequest?.(request);
      check();
      return consume(
        {
          kind: "session-exact-entries",
          source: nativeSource,
          databaseIdentity: {
            identity: "native",
            incarnation: "synthetic-incarnation",
            filename: branch.storePath,
          },
          entries: [{ sessionKey: branch.sessionKey, entry: { ...branch, updatedAt: 1 } }],
          lifecycleTimestamps: {},
        },
        check,
      );
    },
  };
  return prepareConversationKnowledgeCheckpointSources({
    branch,
    participant: person,
    audience: {
      agentId: branch.agentId,
      sessionKey: branch.sessionKey,
      channelId: "test",
      accountId: "default",
      nativeChannelId: "private-endpoint",
      participant: person,
      assertCurrent: options?.authority?.assertCurrent ?? assertCurrent,
    },
    reader,
    signal: options?.signal ?? new AbortController().signal,
    assertCurrent,
    authority: options?.authority,
    getRuntimeConfig: () => config,
    retainCleanup: (release) => cleanups.add(release),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  boundary.target.mockResolvedValue({
    kind: "ready",
    branch,
    targetFacts: { assertCurrent() {}, release: boundary.targetRelease },
  });
  boundary.context.mockImplementation(
    async (_target, consume: (context: SessionTranscriptModelContext) => unknown) =>
      consume({
        events: [
          {
            type: "message",
            id: "original-message",
            message: { role: "user", content: "A complete original observation." },
          },
        ],
        version: { generation: "current", rawSeq: 1, updatedAt: 1 },
      }),
  );
});
afterEach(() => {
  for (const release of cleanups) {
    release();
  }
  cleanups.clear();
});

describe("checkpoint unavailable source custody", () => {
  it("keeps the admitted broker in the initial root snapshot's native cohort", async () => {
    const requests: string[][] = [];
    await sources(() => {}, {
      authority: { signal: new AbortController().signal, assertCurrent() {} },
      onReadRequest(request) {
        // Native cohort expected.sessions names this reader's broker, so every
        // snapshot must return it alongside the root whose transcript is read.
        expect(request.sessionKeys).toContain(branch.sessionKey);
        requests.push([...request.sessionKeys]);
      },
    });
    expect(requests[0]).toEqual([branch.sessionKey, branch.root.sessionKey]);
  });
  it("keeps published source authority after quantum cancellation while stopping further hydration", async () => {
    const quantum = new AbortController();
    const lifetime = new AbortController();
    const held = await sources(() => quantum.signal.throwIfAborted(), {
      signal: quantum.signal,
      authority: { signal: lifetime.signal, assertCurrent: () => lifetime.signal.throwIfAborted() },
    });
    await held.read(reference());
    const source = held.source();
    quantum.abort(new Error("Hydration paused"));
    expect(() => source()).not.toThrow();
    await expect(held.validate(reference())).rejects.toThrow("Hydration paused");
    lifetime.abort(new Error("Broker lifetime ended"));
    expect(() => source()).toThrow("Broker lifetime ended");
  });
  it("checks a cached prefix separately even when its original range anchors still match", async () => {
    const held = await sources();
    const packet = (await held.read(reference()))!.packet;
    boundary.anchors.mockImplementation(async (_target, selection) => ({
      anchors: [],
      contextValidated: !selection.contextValidation.version,
      contextVersion: { generation: "current", rawSeq: 1, updatedAt: 1 },
    }));
    await expect(held.validate(reference(), packet)).resolves.toBeUndefined();
    expect(boundary.anchors).toHaveBeenCalledOnce();
    expect(boundary.anchors.mock.calls[0]![1].contextValidation).toEqual({
      version: packet.version,
    });
  });
  it("leaves a stale own anchor unresolved and still reads a later valid original", async () => {
    const held = await sources();
    const stale = reference("old-generation");
    const before = structuredClone(stale);
    boundary.context.mockRejectedValueOnce(
      new SessionTranscriptReadFenceError("Completed-turn transcript anchor changed"),
    );
    await expect(held.read(stale)).resolves.toBeUndefined();
    expect(stale).toEqual(before);
    expect(boundary.context.mock.calls[0]![4]).toEqual(stale.through);
    expect(await held.read(reference())).toMatchObject({
      complete: true,
      packet: { through: reference().through },
    });
    expect(boundary.debug).toHaveBeenCalledWith(expect.any(String), {
      rootHash: expect.any(String),
      sourceHash: expect.any(String),
      reason: "source-range-unavailable",
    });
    expect(JSON.stringify(boundary.debug.mock.calls)).not.toContain(branch.sessionId);
  });
  it("does not hide unavailable storage facts or revoked broker authority", async () => {
    let current = true;
    const held = await sources(() => {
      if (!current) {
        throw new Error("Broker revoked");
      }
    });
    const failure = new SessionMutationFactsUnavailableError();
    boundary.context.mockRejectedValueOnce(failure);
    await expect(held.read(reference())).rejects.toBe(failure);
    boundary.context.mockImplementationOnce(async () => {
      current = false;
      throw new SessionTranscriptReadFenceError("Source rewritten");
    });
    await expect(held.read(reference())).rejects.toThrow("Broker revoked");
    current = true;
  });
  it("does not verify changed own ranges or acknowledge their checkpoint coverage", async () => {
    const held = await sources();
    boundary.anchors.mockResolvedValue({ anchors: [] });
    const verified = vi.fn();
    await expect(held.validate(reference())).resolves.toBeUndefined();
    await expect(held.verifyAll([reference()], verified)).resolves.toBe(false);
    expect(verified).not.toHaveBeenCalled();
  });
  it("releases a newly acquired group when native personal read refuses its range", async () => {
    const held = await sources();
    const original = reference();
    const donor = {
      ...original.source,
      sessionKey: "agent:example:other",
      sessionId: "other-instance",
    };
    const through = { ...original.through, ...donor };
    const foreign: ConversationKnowledgeReference = {
      ...original,
      source: donor,
      origin: conversationKnowledgeOrigin(donor, "utterance-observation"),
      through,
      privateAudience: { participant: person, admission: through },
    };
    const release = vi.fn();
    boundary.group.mockResolvedValue({ release });
    boundary.personal.mockRejectedValue(new PersonalConversationReadRefusedError("Range changed"));
    const verified = vi.fn();
    await expect(held.verifyAll([foreign], verified)).resolves.toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(verified).not.toHaveBeenCalled();
    held.release();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("grouped checkpoint prefix validation", () => {
  function groupFixture(count: number, cachedVersions: number[]) {
    const donor = {
      ...reference().source,
      sessionKey: "agent:example:donor",
      sessionId: "donor-instance",
    };
    const references: ConversationKnowledgeReference[] = Array.from(
      { length: count },
      (_, index) => {
        const through = {
          ...reference().through,
          ...donor,
          entryId: `original-${index}`,
          rawSeq: index + 1,
        };
        return {
          ...reference(),
          source: donor,
          origin: conversationKnowledgeOrigin(donor, "utterance-observation"),
          through,
          privateAudience: { participant: person, admission: through },
        };
      },
    );
    const current = { generation: "current", rawSeq: 200, updatedAt: 200 };
    const packets = new Map<string, PreparedConversationKnowledgePacket>(
      references.map((value, index) => {
        const rawSeq = cachedVersions[index % cachedVersions.length]!;
        return [
          conversationKnowledgeContributionId(value),
          {
            part: {
              origin: value.origin,
              text: "synthetic",
              complete: true,
              nextOffset: undefined,
              frontier: undefined,
            },
            version: { ...current, rawSeq, updatedAt: rawSeq },
            through: value.through,
            from: value.privateAudience!.admission,
          },
        ];
      }),
    );
    const release = vi.fn();
    boundary.group.mockResolvedValue({ release });
    boundary.personal.mockResolvedValue({
      sources: [
        {
          ...donor,
          agentId: branch.agentId,
          canonicalKey: donor.sessionKey,
          lifecycleRevision: "current-donor-life",
          readSource: nativeSource,
        },
      ],
      assertCurrent() {},
      release: vi.fn(),
      selectContribution: (value: ConversationKnowledgeReference) => ({
        through: value.through,
        from: value.privateAudience!.admission,
        version: current,
      }),
    });
    boundary.anchors.mockResolvedValue({
      anchors: [],
      contextValidated: true,
      contextVersion: current,
    });
    return { references, packets, current, release };
  }

  it("prepares only 37 fresh donor grants for a 505-original frame after individual hydration", async () => {
    const fixture = groupFixture(505, [200]);
    const references = fixture.references.map((value, index) => {
      const source = {
        ...value.source,
        sessionKey: `agent:example:donor-${index % 37}`,
        sessionId: `donor-${index % 37}`,
      };
      const through = { ...value.through, ...source };
      return {
        ...value,
        source,
        origin: conversationKnowledgeOrigin(source, "utterance-observation"),
        through,
        privateAudience: { participant: person, admission: through },
      };
    });
    const prepareGrants: ReturnType<typeof vi.fn>[] = [];
    boundary.personal.mockImplementation(async ({ sources: selected }) => {
      const donor = selected[0];
      const prepare = vi.fn(async () => ({ assertCurrent() {}, checks: [] }));
      prepareGrants.push(prepare);
      return {
        sources: [{ ...donor, canonicalKey: donor.sessionKey, readSource: nativeSource }],
        assertCurrent: Object.assign(() => {}, { prepareSessionSource: prepare }),
        release() {},
        selectContribution: (value: ConversationKnowledgeReference) => ({
          through: value.through,
          from: value.privateAudience!.admission,
          version: fixture.current,
        }),
      };
    });
    const held = await sources();
    for (const original of references) {
      expect(await held.verifyAll([original], () => {})).toBe(true);
    }
    expect(prepareGrants).toHaveLength(505);
    const frameProofs = new Set<SessionSourceAssertion>();
    expect(
      await held.verifyAll(
        references,
        () => {},
        undefined,
        (proof) => frameProofs.add(proof),
      ),
    ).toBe(true);
    expect(prepareGrants).toHaveLength(542);
    const authority = await prepareSessionSourceAuthority(held.source([...frameProofs]));
    expect(prepareGrants.slice(0, 505).every((prepare) => prepare.mock.calls.length === 0)).toBe(
      true,
    );
    expect(prepareGrants.slice(505).every((prepare) => prepare.mock.calls.length === 1)).toBe(true);
    // Existing version proofs are retained even though individual hydration already created them.
    expect(authority.checks.filter(({ predicate }) => predicate.transcript)).toHaveLength(37);
  });

  it.each([
    { versions: [200], anchorReads: 0, predicates: 1 },
    { versions: [100], anchorReads: 1, predicates: 2 },
    { versions: [100, 120], anchorReads: 2, predicates: 3 },
  ])(
    "validates 80 originals once per donor and distinct prefix: %j",
    async ({ versions, anchorReads, predicates }) => {
      const fixture = groupFixture(80, versions);
      const held = await sources();
      const verified = vi.fn();
      expect(await held.verifyAll(fixture.references, verified, fixture.packets)).toBe(true);
      expect(boundary.group).toHaveBeenCalledOnce();
      expect(boundary.personal).toHaveBeenCalledOnce();
      expect(boundary.anchors).toHaveBeenCalledTimes(anchorReads);
      expect(verified).toHaveBeenCalledTimes(80);
      expect(verified.mock.calls[0]![1].claim).toMatchObject({
        reference: fixture.references[0],
        version: fixture.current,
        predicate: { expected: { lifecycleRevision: "current-donor-life" } },
      });
      const prepared = await prepareSessionSourceAuthority(held.source());
      expect(prepared.checks.filter(({ predicate }) => predicate.transcript)).toHaveLength(
        predicates,
      );
      expect(fixture.release).toHaveBeenCalledOnce();
    },
  );

  it("publishes no partial group on failed prefix validation and can retry under fresh custody", async () => {
    const fixture = groupFixture(80, [100, 120]);
    const held = await sources();
    const verified = vi.fn();
    boundary.anchors
      .mockResolvedValueOnce({
        anchors: [],
        contextValidated: true,
        contextVersion: fixture.current,
      })
      .mockResolvedValueOnce({ anchors: [] });
    expect(await held.verifyAll(fixture.references, verified, fixture.packets)).toBe(false);
    expect(verified).not.toHaveBeenCalled();
    expect((await prepareSessionSourceAuthority(held.source())).checks).toHaveLength(0);
    expect(await held.verifyAll(fixture.references, verified, fixture.packets)).toBe(true);
    expect(verified).toHaveBeenCalledTimes(80);
    expect(
      (await prepareSessionSourceAuthority(held.source())).checks.filter(
        ({ predicate }) => predicate.transcript,
      ),
    ).toHaveLength(3);
  });

  it("does not reuse cached text when its granted range differs", async () => {
    const fixture = groupFixture(2, [200]);
    const first = fixture.references[0]!;
    const id = conversationKnowledgeContributionId(first);
    const packet = fixture.packets.get(id)!;
    fixture.packets.set(id, {
      ...packet,
      through: { ...packet.through, generation: "stale-generation" },
    });
    const held = await sources();
    const verified = vi.fn();
    expect(await held.verifyAll(fixture.references, verified, fixture.packets)).toBe(false);
    expect(verified).not.toHaveBeenCalled();
    expect(boundary.anchors).not.toHaveBeenCalled();
  });

  it("continues independent healthy donors after an earlier group is unavailable", async () => {
    const fixture = groupFixture(80, [200]);
    const original = fixture.references[0]!;
    const missingSource = {
      ...original.source,
      sessionKey: "agent:example:missing",
      sessionId: "missing-instance",
    };
    const through = { ...original.through, ...missingSource };
    const unavailable: ConversationKnowledgeReference = {
      ...original,
      source: missingSource,
      origin: conversationKnowledgeOrigin(missingSource, "utterance-observation"),
      through,
      privateAudience: { participant: person, admission: through },
    };
    boundary.group.mockRejectedValueOnce(
      new PersonalConversationReadRefusedError("Missing original source"),
    );
    const held = await sources();
    const verified = vi.fn();
    expect(
      await held.verifyAll([unavailable, ...fixture.references], verified, fixture.packets),
    ).toBe(false);
    expect(boundary.group).toHaveBeenCalledTimes(2);
    expect(boundary.personal).toHaveBeenCalledOnce();
    expect(boundary.anchors).not.toHaveBeenCalled();
    expect(verified).toHaveBeenCalledTimes(80);
    expect(
      verified.mock.calls.every(([value]) => value.source.sessionId === "donor-instance"),
    ).toBe(true);
    expect(
      (await prepareSessionSourceAuthority(held.source())).checks.filter(
        ({ predicate }) => predicate.transcript,
      ),
    ).toHaveLength(1);
  });
});
