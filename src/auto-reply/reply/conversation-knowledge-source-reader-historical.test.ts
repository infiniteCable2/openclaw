import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversationKnowledgeOrigin,
  type ConversationKnowledgeReference,
} from "../../config/sessions/conversation-knowledge.js";
import {
  createConversationKnowledgeSourceReader,
  type ConversationKnowledgeHeldSource,
} from "./conversation-knowledge-source-reader.js";

const native = vi.hoisted(() => ({
  prepare: vi.fn(),
  select: vi.fn(),
  assert: vi.fn(),
  release: vi.fn(),
}));
// mock-isolation: Native personal-read tests prove historical private admission; this covers its raw-reader handoff.
vi.mock("../../gateway/session-transcript-read-authority.js", () => ({
  prepareTranscriptReadAuthority: native.prepare,
}));

const original = {
  agentId: "example",
  sessionKey: "agent:example:donor",
  sessionId: "donor",
  lifecycleRevision: "old-life",
};
const through = {
  agentId: original.agentId,
  sessionKey: original.sessionKey,
  sessionId: original.sessionId,
  storePath: "/synthetic/agent.sqlite",
  generation: "generation",
  rawSeq: 2,
  entryId: "input",
  effectiveParentId: null,
  activeMessagePosition: 1,
};
const receipt: ConversationKnowledgeReference = {
  version: 1,
  kind: "utterance-observation",
  role: "user",
  sourceMode: "branches",
  source: original,
  origin: conversationKnowledgeOrigin(original, "utterance-observation"),
  through,
  privateAudience: { participant: { type: "profile", id: "example-person" }, admission: through },
};
const admitted = {
  originalLifecycleRevision: original.lifecycleRevision,
  currentLifecycleRevision: "current-life",
  origin: receipt.origin,
  through,
  from: through,
};
function reader() {
  const reads: ConversationKnowledgeHeldSource[] = [];
  const drop = (read: ConversationKnowledgeHeldSource) => {
    read.grant.release();
    reads.splice(reads.indexOf(read), 1);
  };
  const owner = createConversationKnowledgeSourceReader({
    branch: {
      agentId: "example",
      sessionKey: "agent:example:recipient",
      sessionId: "recipient",
      lifecycleRevision: "recipient-life",
      storePath: through.storePath,
      root: { sessionKey: "agent:example:root", sessionId: "root", lifecycleRevision: "root-life" },
    },
    originalParticipant: { type: "profile", id: "example-person" },
    targetFacts: {
      audienceIdentity: "private-person",
      assertCurrent() {},
    } as unknown as Parameters<typeof createConversationKnowledgeSourceReader>[0]["targetFacts"],
    assertCurrent() {},
    getRuntimeConfig: () => ({}),
    hasRetainedContribution: () => false,
    reads,
    drop,
  });
  return { owner, reads, drop };
}
beforeEach(() => {
  for (const mock of Object.values(native)) mock.mockReset();
  native.select.mockReturnValue(admitted);
  native.prepare.mockResolvedValue({
    sources: [
      {
        ...original,
        canonicalKey: original.sessionKey,
        storePath: through.storePath,
        lifecycleRevision: "current-life",
      },
    ],
    audienceIdentity: "private-person",
    selectContribution: native.select,
    assertCurrent: native.assert,
    release: native.release,
    contributionRange: { through, from: through },
  });
});
describe("historical contribution raw-reader custody", () => {
  it("keeps original provenance while consuming current native historical custody", async () => {
    const saved = structuredClone(receipt);
    const f = reader();
    const { source } = await f.owner.take(receipt);
    expect(source).toBeDefined();
    expect(native.select).toHaveBeenCalledWith(receipt);
    expect(source!.through).toEqual(through);
    expect(source!.facts.sources[0]?.lifecycleRevision).toBe("current-life");
    expect(receipt).toEqual(saved);
    source!.sourceAssertion();
    native.assert.mockImplementation(() => {
      throw new Error("Current native custody revoked");
    });
    expect(() => source!.sourceAssertion()).toThrow("custody revoked");
    f.drop(source!.read);
    expect(native.release).toHaveBeenCalledOnce();
  });
  it.each([
    undefined,
    { ...admitted, originalLifecycleRevision: "wrong-old" },
    { ...admitted, currentLifecycleRevision: "wrong-current" },
  ])("refuses a missing or differently bound historical selection: %s", async (selection) => {
    native.select.mockReturnValue(selection);
    const f = reader();
    expect((await f.owner.take(receipt)).source).toBeUndefined();
    expect(f.reads).toEqual([]);
    expect(native.release).toHaveBeenCalledOnce();
  });
});
