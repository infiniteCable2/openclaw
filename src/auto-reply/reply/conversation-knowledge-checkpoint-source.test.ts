import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import {
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SessionTranscriptModelContext } from "../../config/sessions/session-history-read.types.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { PersonalConversationReadRefusedError } from "../../gateway/session-mutation-authorization-error.js";
import { SessionMutationFactsUnavailableError } from "../../gateway/session-sharing-incognito.js";
import { prepareConversationKnowledgeCheckpointSources } from "./conversation-knowledge-checkpoint-source.js";

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
async function sources(assertCurrent = () => {}) {
  const reader: SessionEntryCohortReader = {
    database: { agentId: branch.agentId, path: branch.storePath, env: {} },
    logicalAgentId: branch.agentId,
    storePaths: [branch.storePath],
    sessionKey: branch.sessionKey,
    assertCurrent,
    async withRead(_request, check, consume) {
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
      assertCurrent,
    },
    reader,
    signal: new AbortController().signal,
    assertCurrent,
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
