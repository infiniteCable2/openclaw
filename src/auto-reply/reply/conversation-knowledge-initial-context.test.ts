import { beforeEach, expect, it, vi } from "vitest";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import {
  createConversationKnowledgeCheckpoint,
  prepareConversationKnowledgeCheckpointCoverage,
} from "../../config/sessions/conversation-knowledge-checkpoint.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import {
  conversationKnowledgeOrigin,
  projectConversationKnowledge,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { PreparedInitialSessionContextSourceClaim } from "../../config/sessions/session-initial-context.js";
import { prepareSessionSourceAuthority } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareConversationKnowledgeInitialContext } from "./conversation-knowledge-initial-context.js";

const boundary = vi.hoisted(() => ({
  admission: vi.fn(),
  creation: vi.fn(),
  sources: vi.fn(),
  warm: vi.fn(),
  acquire: vi.fn(),
  latest: vi.fn(),
  coverage: vi.fn(),
  bind: vi.fn(),
  entry: vi.fn(),
  releaseCreation: vi.fn(),
  releaseAdmission: vi.fn(),
  releaseSources: vi.fn(),
}));
// mock-isolation: The real native writer is covered by its creation tests; this suite owns projection planning.
vi.mock("../../config/sessions/session-accessor.sqlite-entry-admission.js", () => ({
  loadSessionEntryForAdmission: boundary.admission,
}));
// mock-isolation: Supply explicitly prepared creation authority without opening SQLite or mutating a recipient.
vi.mock("../../config/sessions/conversation-branch-creation.js", () => ({
  prepareConversationBranchCreation: boundary.creation,
}));
// mock-isolation: Fresh donor custody is observable independently from reusable immutable text.
vi.mock("./conversation-knowledge-checkpoint-source.js", () => ({
  prepareConversationKnowledgeCheckpointSources: boundary.sources,
}));
// mock-isolation: The root cache returns detached data; it never grants permission in this suite.
vi.mock("./conversation-knowledge-checkpoint-owner.js", () => ({
  acquirePreparedConversationKnowledgeInitialFrame: boundary.acquire,
  readPreparedConversationKnowledgeRootProjection: boundary.warm,
}));
// mock-isolation: Fixed canonical checkpoint records exercise summary coverage without a report worker.
vi.mock("../../config/sessions/conversation-knowledge-checkpoint-store.js", () => ({
  readLatestConversationKnowledgeCheckpoint: boundary.latest,
  readConversationKnowledgeCheckpointCoverage: boundary.coverage,
}));

const branch: ConversationKnowledgeBranch = {
  agentId: "example",
  sessionKey: "agent:example:new",
  sessionId: "new-instance",
  lifecycleRevision: "new-life",
  storePath: "/synthetic/initial-context.sqlite",
  root: {
    sessionKey: "agent:example:root",
    sessionId: "root-instance",
    lifecycleRevision: "root-life",
  },
};
const participant = { type: "profile", id: "synthetic-person" } as const;
const audienceKey = conversationKnowledgeParticipantIdentity(participant)!;
const nativeSource = {
  agentId: branch.agentId,
  path: branch.storePath,
  databaseIdentity: "native",
};
const rootEntry = {
  sessionId: branch.root.sessionId,
  lifecycleRevision: branch.root.lifecycleRevision,
  updatedAt: 1,
};
const rootVersion = { generation: "root-generation", rawSeq: 7, updatedAt: 2 };
const rootReader: SessionEntryCohortReader = {
  sessionKey: branch.root.sessionKey,
  logicalAgentId: branch.agentId,
  database: { agentId: branch.agentId, path: branch.storePath, env: {} },
  storePaths: [branch.storePath],
  assertCurrent() {},
  async withRead(_request, check, consume) {
    check();
    return consume(
      {
        kind: "session-exact-entries",
        source: nativeSource,
        databaseIdentity: {
          identity: "native",
          incarnation: "native-owner",
          filename: branch.storePath,
        },
        entries: [{ sessionKey: branch.root.sessionKey, entry: rootEntry }],
        lifecycleTimestamps: {},
        transcript: { anchors: [], contextVersion: rootVersion },
      },
      check,
    );
  },
};
function sourceFixture(index: number) {
  const source = {
    agentId: branch.agentId,
    sessionKey: `agent:example:source-${index}`,
    sessionId: `source-${index}`,
    lifecycleRevision: "current-source-life",
  };
  const through = {
    ...source,
    storePath: branch.storePath,
    generation: "donor-generation",
    entryId: `message-${index}`,
    rawSeq: 1,
    activeMessagePosition: 0,
    effectiveParentId: null,
  };
  const reference: ConversationKnowledgeReference = {
    version: 1,
    sourceMode: "branches",
    source,
    origin: conversationKnowledgeOrigin(source, "utterance-observation"),
    through,
    kind: "utterance-observation",
    role: "user",
    privateAudience: { participant, admission: through },
  };
  const part = projectConversationKnowledge(
    reference,
    [
      {
        type: "message",
        id: through.entryId,
        parentId: null,
        message: { role: "user", content: `Original fact ${index}.` },
      },
    ],
    undefined,
    "private-direct",
  );
  if (!part) {
    throw new Error("Synthetic contribution is invalid");
  }
  const version = { generation: through.generation, rawSeq: 1, updatedAt: 3 };
  const claim: PreparedInitialSessionContextSourceClaim = {
    reference,
    predicate: {
      source: nativeSource,
      sessionKey: source.sessionKey,
      fields: ["sessionId", "lifecycleRevision"],
      expected: source,
      transcript: { sessionId: source.sessionId, version, consistency: "prefix" },
    },
    sessionId: source.sessionId,
    version,
    through,
    from: through,
  };
  return { reference, packet: { part, through, from: through, version }, claim };
}
const first = sourceFixture(1);
const second = sourceFixture(2);
const assertCurrent = () => {};
const donorSource = Object.assign(assertCurrent, {
  prepareSessionSource: async () => ({
    assertCurrent,
    checks: [first, second].map(({ claim }) => ({
      predicate: claim.predicate,
      refuse: (): never => {
        throw new Error("Synthetic donor revoked");
      },
    })),
  }),
});
const sources = {
  audienceKey,
  references: [first.reference, second.reference],
  read: vi.fn(),
  validate: vi.fn(),
  verifyAll: vi.fn(),
  source: () => donorSource,
};
function params() {
  const cfg = { agents: { entries: { example: { conversationMode: "branches" as const } } } };
  return {
    agentId: branch.agentId,
    storePath: branch.storePath,
    sessionKey: branch.sessionKey,
    sessionEntry: {
      sessionId: branch.sessionId,
      lifecycleRevision: branch.lifecycleRevision,
      updatedAt: 1,
      visibility: "draft" as const,
      conversationTopology: {
        version: 1 as const,
        role: "branch" as const,
        rootSessionKey: branch.root.sessionKey,
        rootSessionId: branch.root.sessionId,
        rootSessionLifecycleRevision: branch.root.lifecycleRevision,
      },
    },
    cfg,
    getRuntimeConfig: () => cfg,
    audience: {
      agentId: branch.agentId,
      sessionKey: branch.sessionKey,
      participant,
      assertCurrent,
      channelId: "example",
      accountId: "default",
      nativeChannelId: "private-example",
    },
    assertCurrent,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  boundary.acquire.mockReset();
  boundary.admission.mockResolvedValue({
    databaseClaim: { kind: "worker", reader: rootReader, release: boundary.releaseAdmission },
  });
  boundary.creation.mockResolvedValue({
    branch,
    participant,
    source: assertCurrent,
    bindCreation: boundary.bind,
    assertEntry: boundary.entry,
    release: boundary.releaseCreation,
  });
  boundary.sources.mockImplementation(async (input) => {
    input.retainCleanup(boundary.releaseSources);
    return sources;
  });
  boundary.warm.mockReturnValue(undefined);
  boundary.latest.mockResolvedValue(undefined);
  sources.read.mockImplementation(async (reference) =>
    reference === first.reference ? first : second,
  );
  sources.validate.mockImplementation(async (reference) =>
    reference === first.reference ? first.claim : second.claim,
  );
  sources.verifyAll.mockImplementation(async (references, verified) => {
    for (const reference of references) {
      const selected = reference === first.reference ? first : second;
      verified(reference, {
        through: selected.packet.through,
        from: selected.packet.from,
        claim: selected.claim,
      });
    }
    return true;
  });
});

it("falls back from a stale former broker while retaining the new destination's authority", async () => {
  boundary.acquire.mockImplementation(() => {
    throw new Error("Former broker ended");
  });
  const prepared = await prepareConversationKnowledgeInitialContext(params());
  expect(prepared?.context.kind).toBe("root-projection");
  expect(boundary.sources).toHaveBeenCalledOnce();
  await prepared?.release();
});

it("does not treat revoked creating authority as optional stale frame lookup", async () => {
  const input = params();
  let current = true;
  input.assertCurrent = () => {
    if (!current) {
      throw new Error("Creating authority revoked");
    }
  };
  boundary.acquire.mockImplementation(() => {
    current = false;
    throw new Error("Former broker ended");
  });
  await expect(prepareConversationKnowledgeInitialContext(input)).rejects.toThrow(
    "Creating authority revoked",
  );
  expect(boundary.sources).not.toHaveBeenCalled();
});

it("prepares the whole ordered brokerless tail before creation and retains exact source authority", async () => {
  const prepared = await prepareConversationKnowledgeInitialContext(params());
  expect(prepared).toBeDefined();
  expect(boundary.admission.mock.calls[0]?.[0].sessionKey).toBe(branch.root.sessionKey);
  expect(prepared?.context.kind).toBe("root-projection");
  if (prepared?.context.kind !== "root-projection") {
    throw new Error("Expected projected context");
  }
  expect(
    prepared.context.projection.packets.map((packet) => packet.receipt.source.sessionId),
  ).toEqual(["source-1", "source-2"]);
  expect(prepared.context.events).toHaveLength(3);
  expect(
    prepared.context.projection.packets.every((packet) => packet.complete && packet.offset === 0),
  ).toBe(true);
  const authority = await prepareSessionSourceAuthority(prepared.source);
  expect(authority.checks.map(({ predicate }) => predicate)).toEqual(
    expect.arrayContaining([first.claim.predicate, second.claim.predicate]),
  );
  expect(
    authority.checks.filter(({ predicate }) => predicate.sessionKey === branch.root.sessionKey),
  ).toHaveLength(2);
  prepared.assertEntry(params().sessionEntry);
  expect(boundary.entry).toHaveBeenCalledOnce();
  await prepared.release();
  await prepared.release();
  expect(boundary.releaseAdmission).toHaveBeenCalledOnce();
  expect(boundary.releaseCreation).toHaveBeenCalledOnce();
  expect(boundary.releaseSources).toHaveBeenCalledOnce();
  expect(prepared.source).toThrow("released");
});

it("reuses warm text only after fresh source validation", async () => {
  boundary.warm.mockReturnValue({ audienceKey, tail: [first, second] });
  sources.validate.mockImplementation(async (reference) => ({
    through: reference.through,
    from: reference.through,
    claim: reference === first.reference ? first.claim : second.claim,
  }));
  const prepared = await prepareConversationKnowledgeInitialContext(params());
  expect(sources.read).not.toHaveBeenCalled();
  expect(sources.validate).not.toHaveBeenCalled();
  expect(sources.verifyAll).toHaveBeenCalledOnce();
  expect(prepared?.context.events).toHaveLength(3);
  await prepared?.release();
});

it("rereads an unverified warm group instead of installing unchecked cached text", async () => {
  boundary.warm.mockReturnValue({ audienceKey, tail: [first, second] });
  sources.verifyAll.mockResolvedValue(false);
  const prepared = await prepareConversationKnowledgeInitialContext(params());
  expect(sources.read).toHaveBeenCalledTimes(2);
  expect(prepared?.context.events).toHaveLength(3);
  await prepared?.release();
});

it("keeps a later validated warm donor when the aggregate bulk result is incomplete", async () => {
  boundary.warm.mockReturnValue({ audienceKey, tail: [first, second] });
  sources.verifyAll.mockImplementation(async (_references, verified) => {
    verified(second.reference, {
      through: second.packet.through,
      from: second.packet.from,
      claim: second.claim,
    });
    return false;
  });
  const prepared = await prepareConversationKnowledgeInitialContext(params());
  expect(sources.read).toHaveBeenCalledExactlyOnceWith(first.reference);
  expect(prepared?.context.events).toHaveLength(3);
  await prepared?.release();
});

it("selects a logical store locator once and binds projection custody to its admitted physical owner", async () => {
  const logicalStore = "/synthetic/agents/example/sessions/sessions.json";
  boundary.creation.mockImplementation(async (input) => {
    // Preserve the strict native equality instead of accepting locator aliases.
    if (input.branch.storePath !== input.reader.database.path) {
      throw new Error("Conversation creation absence or root changed");
    }
    return {
      branch: input.branch,
      participant,
      source: assertCurrent,
      bindCreation: boundary.bind,
      assertEntry: boundary.entry,
      release: boundary.releaseCreation,
    };
  });
  const prepared = await prepareConversationKnowledgeInitialContext({
    ...params(),
    storePath: logicalStore,
  });
  expect(boundary.admission.mock.calls[0]?.[0].storePath).toBe(logicalStore);
  expect(boundary.creation.mock.calls[0]?.[0].branch.storePath).toBe(rootReader.database.path);
  expect(boundary.sources.mock.calls[0]?.[0].branch.storePath).toBe(rootReader.database.path);
  if (prepared?.context.kind !== "root-projection") {
    throw new Error("Expected projected context");
  }
  expect(prepared.context.projection.branch.storePath).toBe(rootReader.database.path);
  expect(prepared.context.source.path).toBe(rootReader.database.path);
  expect(
    prepared.context.projection.claims.every(
      ({ predicate }) => predicate.source.path === rootReader.database.path,
    ),
  ).toBe(true);
  await prepared.release();
  expect(boundary.releaseAdmission).toHaveBeenCalledOnce();
});

it("uses a real checkpoint only after authorizing its entire covered range", async () => {
  const checkpoint = createConversationKnowledgeCheckpoint({
    audienceKey,
    branch,
    summary: "A synthetic previous fact.",
    covered: [first.reference],
  });
  const coverage = prepareConversationKnowledgeCheckpointCoverage({
    checkpoint,
    records: [checkpoint],
    assertCurrent,
  });
  boundary.latest.mockResolvedValue(checkpoint);
  boundary.coverage.mockResolvedValue(coverage);
  sources.validate.mockResolvedValue({
    through: first.packet.through,
    from: first.packet.from,
    claim: first.claim,
  });
  const prepared = await prepareConversationKnowledgeInitialContext(params());
  if (prepared?.context.kind !== "root-projection") {
    throw new Error("Expected projected context");
  }
  expect(prepared.context.projection.checkpoint).toEqual(checkpoint);
  expect(prepared.context.projection.packets).toHaveLength(1);
  expect(prepared.context.projection.claims).toHaveLength(2);
  expect(sources.read).toHaveBeenCalledExactlyOnceWith(second.reference);
  await prepared.release();
});

it("does not open a root or disclose projection data without a verified private destination", async () => {
  expect(
    await prepareConversationKnowledgeInitialContext({ ...params(), audience: undefined }),
  ).toBeUndefined();
  expect(boundary.admission).not.toHaveBeenCalled();
});

it("declines optional copying when a remote person is not the destination's Gateway creator", async () => {
  const input = params();
  const sessionEntry = {
    ...input.sessionEntry,
    createdActor: { type: "human" as const, source: "profile" as const, id: "profile-owner" },
  };
  expect(
    await prepareConversationKnowledgeInitialContext({
      ...input,
      sessionEntry,
      audience: {
        ...input.audience,
        participant: {
          type: "remote",
          pluginId: "example",
          domain: "example.test",
          idKind: "user-id",
          id: "remote-person",
        },
      },
    }),
  ).toBeUndefined();
  expect(boundary.admission).not.toHaveBeenCalled();
  expect(boundary.creation).not.toHaveBeenCalled();
  expect(boundary.sources).not.toHaveBeenCalled();
  expect(sessionEntry.createdActor.id).toBe("profile-owner");
  expect(sessionEntry.visibility).toBe("draft");
});

it("still prepares optional copying for its confirmed profile creator", async () => {
  const input = params();
  const prepared = await prepareConversationKnowledgeInitialContext({
    ...input,
    sessionEntry: {
      ...input.sessionEntry,
      createdActor: { type: "human", source: "profile", id: participant.id },
    },
  });
  expect(prepared?.context.kind).toBe("root-projection");
  expect(boundary.creation).toHaveBeenCalledOnce();
  await prepared?.release();
});

it("does not turn revoked host audience proof into optional ineligibility", async () => {
  const input = params();
  await expect(
    prepareConversationKnowledgeInitialContext({
      ...input,
      audience: {
        ...input.audience,
        assertCurrent() {
          throw new Error("Original host audience revoked");
        },
      },
    }),
  ).rejects.toThrow("Original host audience revoked");
  expect(boundary.admission).not.toHaveBeenCalled();
});

it.each([
  { parentSessionKey: "agent:example:parent" },
  { parentSessionId: "parent-instance" },
  { parentSessionLifecycleRevision: "parent-life" },
  { spawnedBy: "agent:example:parent" },
  { spawnedBySessionId: "parent-instance" },
  { spawnDepth: 1 },
  { forkSource: { sessionKey: "agent:example:parent", sessionId: "explicit-fork" } },
  { forkedFromParent: true },
  { incognito: true as const },
])("preserves intentional lineage without opening root projection: %j", async (lineage) => {
  const input = params();
  expect(
    await prepareConversationKnowledgeInitialContext({
      ...input,
      sessionEntry: Object.assign(input.sessionEntry, lineage),
    }),
  ).toBeUndefined();
  expect(boundary.admission).not.toHaveBeenCalled();
  expect(boundary.creation).not.toHaveBeenCalled();
});

it("releases every acquired owner when preparation is interrupted", async () => {
  boundary.sources.mockImplementation(async (input) => {
    input.retainCleanup(boundary.releaseSources);
    throw new Error("Synthetic preparation interrupted");
  });
  await expect(prepareConversationKnowledgeInitialContext(params())).rejects.toThrow(
    "Synthetic preparation interrupted",
  );
  expect(boundary.releaseSources).toHaveBeenCalledOnce();
  expect(boundary.releaseCreation).toHaveBeenCalledOnce();
  expect(boundary.releaseAdmission).toHaveBeenCalledOnce();
});

it("refuses replaced runtime configuration before exposing prepared history", async () => {
  const input = params();
  let current: OpenClawConfig = input.cfg;
  boundary.sources.mockImplementation(async (request) => {
    request.retainCleanup(boundary.releaseSources);
    current = { agents: { entries: { example: { conversationMode: "native" } } } };
    return sources;
  });
  await expect(
    prepareConversationKnowledgeInitialContext({ ...input, getRuntimeConfig: () => current }),
  ).rejects.toThrow("configuration changed");
  expect(sources.read).not.toHaveBeenCalled();
  expect(boundary.releaseSources).toHaveBeenCalledOnce();
  expect(boundary.releaseCreation).toHaveBeenCalledOnce();
  expect(boundary.releaseAdmission).toHaveBeenCalledOnce();
});
