import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationKnowledgeParticipantIdentity } from "../../config/sessions/conversation-audience.js";
import {
  CONVERSATION_KNOWLEDGE_REPORT,
  conversationKnowledgeOrigin,
} from "../../config/sessions/conversation-knowledge.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";

const source = vi.hoisted(() => ({
  branch: vi.fn(),
  root: vi.fn(),
  facts: vi.fn(),
  grant: vi.fn(),
  context: vi.fn(),
}));
// mock-isolation: Test retained diagnostic authority without starting transcript workers.
vi.mock("../../config/sessions/conversation-knowledge-store.js", () => ({
  readConversationKnowledgeBranch: source.branch,
  readConversationKnowledgeRoot: source.root,
  recordConversationKnowledgeTurn: vi.fn(),
}));
// mock-isolation: A source gap must not initialize native packet storage or write an observation.
vi.mock("../../config/sessions/conversation-knowledge-packets.js", () => ({
  conversationKnowledgeContributionId: () => "synthetic-contribution",
  readConversationKnowledgePacketProgress: async () => new Map(),
  readActiveConversationKnowledgePacketIds: async () => [],
  retainConversationKnowledgePacket: () => {
    throw new Error("A source gap must never write a packet");
  },
}));
// mock-isolation: Supply revocable facts without initializing unrelated Gateway sharing storage.
vi.mock("./conversation-knowledge-authority.js", () => ({
  prepareConversationKnowledgeBranchFacts: source.facts,
  pendingConversationKnowledgeNotice: () => {
    throw new Error("Direct source preparation must not initialize a turn");
  },
  unavailableConversationKnowledge: () => {
    throw new Error("This fixture requires an already-authorized source");
  },
}));
// mock-isolation: This direct preparation test must not initialize the native publication journal.
vi.mock("./conversation-publication.js", () => ({
  captureReplyConversationPublication: () => {
    throw new Error("A source gap must not capture publication");
  },
  recordReplyConversationPublication: () => {
    throw new Error("A source gap must not publish a turn");
  },
}));
// mock-isolation: Existing seed/lifecycle integration coverage owns actual native turn startup.
vi.mock("../../config/sessions/conversation-knowledge-seed.js", () => ({
  ensureConversationKnowledgeSeed: () => {
    throw new Error("Direct source preparation must not seed history");
  },
}));
// mock-isolation: The direct preparation boundary does not consult a live reply registry.
vi.mock("./reply-run-registry.state.js", () => ({
  getReplyOperationSessionReader: () => {
    throw new Error("Direct source preparation must not acquire a reply operation");
  },
}));
// mock-isolation: A status must retain its existing narrow grant, never request broader access.
vi.mock("../../gateway/session-transcript-read-authority.js", () => ({
  prepareTranscriptReadAuthority: source.grant,
}));
// mock-isolation: Reproduce source gaps without reading a real private transcript.
vi.mock("../../config/sessions/session-transcript-context-read.js", () => ({
  readSessionTranscriptModelContextAsync: source.context,
}));

import { prepareReplyConversationKnowledge } from "./conversation-knowledge.js";

beforeEach(() => {
  for (const mock of Object.values(source)) {
    mock.mockReset();
  }
});

describe("related-history diagnostic source custody", () => {
  it.each(["missing-range", "unverified-exchange"] as const)(
    "retains the authorized source behind a %s notice until the model turn settles",
    async (kind) => {
      const participant = { type: "profile" as const, id: "example-person" };
      const branch = {
        agentId: "example",
        sessionKey: "agent:example:recipient",
        sessionId: "recipient",
        lifecycleRevision: "original",
        storePath: "/synthetic/agent.sqlite",
        root: {
          sessionKey: "agent:example:root",
          sessionId: "root",
          lifecycleRevision: "original",
        },
      };
      const donor = {
        agentId: branch.agentId,
        sessionKey: "agent:example:donor",
        sessionId: "donor",
        lifecycleRevision: "original",
      };
      const audience = conversationKnowledgeParticipantIdentity(participant);
      const release = vi.fn();
      const targetRelease = vi.fn();
      let readable = true;
      const assertSource = () => {
        if (!readable) {
          throw new Error("Diagnostic source revoked");
        }
      };
      source.branch.mockResolvedValue(branch);
      source.facts
        .mockResolvedValueOnce({
          audience: "private-direct",
          audienceIdentity: audience,
          assertCurrent() {},
          release: targetRelease,
        })
        .mockResolvedValueOnce({
          audience: "private-direct",
          audienceIdentity: audience,
          assertCurrent: assertSource,
          release: vi.fn(),
        });
      source.grant.mockResolvedValue({
        sources: [{ ...donor, canonicalKey: donor.sessionKey, storePath: branch.storePath }],
        assertCurrent: assertSource,
        release,
      });
      source.root.mockResolvedValue([
        {
          type: "custom_message",
          customType: CONVERSATION_KNOWLEDGE_REPORT,
          details: {
            version: 1,
            sourceMode: "branches",
            source: donor,
            origin: conversationKnowledgeOrigin(donor),
            runId: "donor-run",
            through: {
              ...donor,
              storePath: branch.storePath,
              generation: "original",
              entryId: "answer",
              rawSeq: 2,
              activeMessagePosition: 1,
              effectiveParentId: "question",
            },
          },
        },
      ]);
      if (kind === "missing-range") {
        source.context.mockRejectedValue(new SessionTranscriptReadFenceError("Missing range"));
      } else {
        source.context.mockImplementation(async (_target, consume) => consume({ events: [] }));
      }
      const reader: SessionEntryCohortReader = {
        database: { agentId: branch.agentId, path: branch.storePath, env: {} },
        logicalAgentId: branch.agentId,
        sessionKey: branch.sessionKey,
        storePaths: [branch.storePath],
        assertCurrent() {},
        async withRead() {
          throw new Error("A source gap must never write a packet");
        },
      };
      const prepared = await prepareReplyConversationKnowledge({
        reader,
        sessionId: branch.sessionId,
        assertCurrent() {},
        originalParticipant: participant,
        getRuntimeConfig: () => ({
          agents: { entries: { example: { conversationMode: "branches" } } },
        }),
        retainInHistory: { writeTarget: branch, maintainContext: async () => {} },
      });
      try {
        expect(prepared?.fragments[0]?.text).toContain(donor.sessionKey);
        expect(release).not.toHaveBeenCalled();
        readable = false;
        expect(() => prepared?.assertCurrent()).toThrow("Diagnostic source revoked");
      } finally {
        prepared?.release();
      }
      expect(release).toHaveBeenCalledOnce();
      expect(targetRelease).toHaveBeenCalledOnce();
    },
  );
});
