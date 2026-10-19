import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversationKnowledgeAudience,
  conversationKnowledgeAudienceIdentity,
  conversationKnowledgeParticipantIdentity,
} from "../../config/sessions/conversation-audience.js";
import type { ConversationKnowledgeBranch } from "../../config/sessions/conversation-knowledge-store.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";

const prepare = vi.hoisted(() => vi.fn());
// mock-isolation: Exercise native prepared-fact custody without opening profile/session workers.
vi.mock("../../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: prepare,
}));

import { prepareConversationKnowledgeBranchFacts } from "./conversation-knowledge-authority.js";

const branch: ConversationKnowledgeBranch = {
  agentId: "example",
  sessionKey: "agent:example:conversation-a",
  sessionId: "conversation-a",
  lifecycleRevision: "original",
  storePath: "/synthetic/agent.sqlite",
  root: {
    sessionKey: "agent:example:main",
    sessionId: "root-original",
    lifecycleRevision: "root-original-revision",
  },
};

function fixture() {
  const entry: InternalSessionEntry = {
    sessionId: branch.sessionId,
    lifecycleRevision: branch.lifecycleRevision,
    updatedAt: 1,
    chatType: "direct",
    participantCount: 1,
    participants: [{ identity: { type: "profile", id: "person-example" } }],
    conversationTopology: {
      version: 1,
      role: "branch",
      rootSessionKey: branch.root.sessionKey,
      rootSessionId: branch.root.sessionId,
      rootSessionLifecycleRevision: branch.root.lifecycleRevision,
    },
  };
  const target = {
    agentId: branch.agentId,
    canonicalKey: branch.sessionKey,
    storeKey: branch.sessionKey,
    storeKeys: [branch.sessionKey],
    storePath: branch.storePath,
    readSource: {
      agentId: branch.agentId,
      path: branch.storePath,
      databaseIdentity: "native-original",
      databaseBirthtime: "native-original-birth",
    },
    entry,
  };
  const held = { readCurrent: vi.fn(() => ({ target })), release: vi.fn() };
  prepare.mockResolvedValue(held);
  return { entry, target, held };
}

beforeEach(() => prepare.mockReset());

describe("native conversation knowledge audience custody", () => {
  it("never infers a private audience from an unknown or shared route", () => {
    expect(conversationKnowledgeAudience({})).toBe("unknown");
    expect(conversationKnowledgeAudience({ chatType: "channel" })).toBe("shared");
    expect(conversationKnowledgeAudience({ chatType: "group" })).toBe("shared");
    expect(conversationKnowledgeAudience({ chatType: "direct", participantCount: 2 })).toBe(
      "unknown",
    );
    expect(
      conversationKnowledgeAudience({
        chatType: "direct",
        publicShare: { id: "share", sessionId: "original", createdAt: 1 },
      }),
    ).toBe("shared");
  });

  it("holds exact native audience predicates and revokes them when released", async () => {
    const f = fixture();
    const facts = await prepareConversationKnowledgeBranchFacts({
      branch,
      getRuntimeConfig: () => ({}),
    });
    expect(facts.audience).toBe("private-direct");
    expect(facts.audienceIdentity).toBe(conversationKnowledgeAudienceIdentity(f.entry));
    const prepared = await facts.assertCurrent.prepareSessionSource?.();
    expect(prepared?.checks[0]?.predicate).toMatchObject({
      source: f.target.readSource,
      sessionKey: branch.sessionKey,
      fields: expect.arrayContaining([
        "chatType",
        "publicShare",
        "participantCount",
        "conversationTopology",
        "participants",
      ]),
      expected: { sessionId: branch.sessionId, lifecycleRevision: branch.lifecycleRevision },
    });
    f.entry.updatedAt = 2;
    expect(() => facts.assertCurrent()).not.toThrow();
    expect(prepared?.checks[0]?.predicate.expected?.updatedAt).toBe(1);
    expect(await facts.assertCurrent.prepareSessionSourceScope?.()).toBeDefined();
    facts.release();
    facts.release();
    expect(f.held.release).toHaveBeenCalledOnce();
    expect(() => facts.assertCurrent()).toThrow("released");
  });

  it.each([false, true])(
    "permits actor-only evolution only with current recipient proof (%s)",
    async (attested) => {
      const f = fixture();
      const destinationAudience = {
        agentId: branch.agentId,
        sessionKey: branch.sessionKey,
        channelId: "webchat",
        accountId: "default",
        nativeChannelId: branch.sessionKey,
        participant: { type: "profile" as const, id: "person-example" },
        assertCurrent() {},
      };
      const facts = await prepareConversationKnowledgeBranchFacts({
        branch,
        getRuntimeConfig: () => ({}),
        ...(attested ? { destinationAudience } : {}),
      });
      try {
        f.entry.participants!.push({ identity: { type: "agent", id: "helper" } });
        f.entry.participantCount = 2;
        if (!attested) {
          expect(() => facts.assertCurrent()).toThrow("audience or incarnation changed");
          return;
        }
        expect(() => facts.assertCurrent()).not.toThrow();
        const prepared = await facts.assertCurrent.prepareSessionSource?.();
        expect(prepared?.checks[0]?.predicate).toMatchObject({
          fields: expect.arrayContaining(["participants", "participantCount"]),
          expected: { participants: f.entry.participants, participantCount: 2 },
        });
        f.entry.participants!.push({ identity: { type: "profile", id: "another-person" } });
        f.entry.participantCount = 3;
        expect(() => facts.assertCurrent()).toThrow("audience or incarnation changed");
      } finally {
        facts.release();
      }
    },
  );

  it.each<Partial<InternalSessionEntry>>([
    { chatType: "channel" },
    { publicShare: { id: "share", sessionId: branch.sessionId, createdAt: 1 } },
    { participantCount: 2 },
    { participants: [{ identity: { type: "profile", id: "another-person" } }] },
    { sessionId: "replacement" },
    { lifecycleRevision: "replacement" },
    { conversationTopology: undefined },
    { incognito: true },
  ])("rejects a changed actual branch fact %j", async (change) => {
    const f = fixture();
    const facts = await prepareConversationKnowledgeBranchFacts({
      branch,
      getRuntimeConfig: () => ({}),
    });
    Object.assign(f.entry, change);
    expect(() => facts.assertCurrent()).toThrow("audience or incarnation changed");
    await expect(facts.assertCurrent.prepareSessionSource?.()).rejects.toThrow(
      "audience or incarnation changed",
    );
    facts.release();
  });

  it("does not adopt another root or physical source and joins failed preparation", async () => {
    const f = fixture();
    f.target.readSource.path = "/synthetic/replacement.sqlite";
    await expect(
      prepareConversationKnowledgeBranchFacts({ branch, getRuntimeConfig: () => ({}) }),
    ).rejects.toThrow("changed");
    expect(f.held.release).toHaveBeenCalledOnce();
  });

  it("compares real native audiences, never observation ids or display labels", () => {
    const direct = { chatType: "direct" as const, participantCount: 1 };
    const first = {
      ...direct,
      participants: [
        { identity: { type: "profile" as const, id: "person-a" }, label: "Same name" },
      ],
    };
    expect(conversationKnowledgeAudienceIdentity(first)).toBeDefined();
    expect(conversationKnowledgeParticipantIdentity(first.participants[0]?.identity)).toBe(
      conversationKnowledgeAudienceIdentity(first),
    );
    expect(conversationKnowledgeParticipantIdentity(undefined)).toBeUndefined();
    expect(
      conversationKnowledgeParticipantIdentity({ type: "agent", id: "example" }),
    ).toBeUndefined();
    expect(
      conversationKnowledgeAudienceIdentity({
        ...direct,
        participants: [{ identity: { type: "profile", id: "person-b" }, label: "Same name" }],
      }),
    ).not.toBe(conversationKnowledgeAudienceIdentity(first));
    expect(
      conversationKnowledgeAudienceIdentity({
        ...first,
        participants: [{ ...first.participants[0]!, label: "A new display name" }],
      }),
    ).toBe(conversationKnowledgeAudienceIdentity(first));
    expect(
      conversationKnowledgeAudienceIdentity({
        ...direct,
        participants: [
          {
            identity: {
              type: "observation",
              pluginId: "matrix",
              accountId: "example",
              senderKind: "human",
              id: "person-a",
            },
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      conversationKnowledgeAudienceIdentity({ ...first, participantCount: 2 }),
    ).toBeUndefined();
    expect(
      conversationKnowledgeAudienceIdentity({ ...first, participantCount: undefined }),
    ).toBeUndefined();
    const remote = {
      ...direct,
      participants: [
        {
          identity: {
            type: "remote" as const,
            pluginId: "matrix",
            domain: "example.invalid",
            idKind: "matrix-user",
            id: "@person:example.invalid",
          },
        },
      ],
    };
    expect(conversationKnowledgeAudienceIdentity(remote)).toBeDefined();
    expect(
      conversationKnowledgeAudienceIdentity({
        ...remote,
        participants: [
          { identity: { ...remote.participants[0]!.identity, domain: "other.invalid" } },
        ],
      }),
    ).not.toBe(conversationKnowledgeAudienceIdentity(remote));
  });
});
