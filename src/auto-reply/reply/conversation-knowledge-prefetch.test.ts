import { beforeEach, describe, expect, it, vi } from "vitest";

const preparation = vi.hoisted(() => ({
  prepare: vi.fn(),
  load: vi.fn(),
  owner: {
    assertCurrent: vi.fn(),
    request: vi.fn(),
    close: vi.fn(),
  },
  create: vi.fn(),
}));
// mock-isolation: Exercise recipient scheduling without starting background database resources.
vi.mock("./conversation-knowledge-prefetch-owner.js", () => ({
  createConversationKnowledgePrefetchOwner: preparation.create,
}));
// mock-isolation: The scheduler needs only a current worker-backed recipient claim.
vi.mock("../../config/sessions/session-accessor.sqlite-entry-admission.js", () => ({
  loadSessionEntryForAdmission: preparation.load,
}));
// mock-isolation: Packet capacity and source fairness are covered at the real preparation boundary.
vi.mock("./conversation-knowledge.js", () => ({
  prepareReplyConversationKnowledge: preparation.prepare,
}));
// mock-isolation: This boundary only schedules packets; cache/native range proofs have focused tests.
vi.mock("./conversation-knowledge-source-cache.js", () => ({
  createConversationKnowledgeSourceCache: () => ({ clear: vi.fn() }),
}));
// mock-isolation: Keep process-global recipient retention private to this test module.
vi.mock("../../shared/global-singleton.js", () => ({
  resolveGlobalSingleton: (_key: symbol, create: () => unknown) => create(),
}));

import { prepareConversationKnowledgeRecipient } from "./conversation-knowledge-prefetch.js";

beforeEach(() => {
  preparation.prepare.mockReset();
  preparation.load.mockReset();
  preparation.create.mockReset().mockReturnValue(preparation.owner);
  for (const mock of Object.values(preparation.owner)) {
    mock.mockReset();
  }
});

describe("recipient preparation scheduling", () => {
  it("prepares every open recipient rather than starving readers outside the newest sixteen", async () => {
    const participant = { type: "profile" as const, id: "example-person" };
    const release = vi.fn();
    preparation.load.mockImplementation(async (target) => ({
      entry: { sessionId: target.sessionId, lifecycleRevision: "original" },
      databaseClaim: { kind: "worker", reader: {}, assertCurrent() {}, release },
    }));
    preparation.prepare.mockImplementation(async () => ({ release() {} }));
    const registrations = Array.from({ length: 20 }, (_, index) => {
      const sessionKey = `agent:example:open-reader-${index}`;
      const recipient = prepareConversationKnowledgeRecipient({
        branch: {
          agentId: "example",
          sessionKey,
          sessionId: `open-reader-${index}`,
          lifecycleRevision: "original",
          storePath: "/synthetic/agent.sqlite",
          root: {
            sessionKey: "agent:example:root",
            sessionId: "root",
            lifecycleRevision: "original",
          },
        },
        participant,
        audience: {
          agentId: "example",
          sessionKey,
          channelId: "example-channel",
          accountId: "default",
          nativeChannelId: `private-reader-${index}`,
          participant,
          assertCurrent() {},
        },
        env: {},
        getRuntimeConfig: () => ({
          agents: { entries: { example: { conversationMode: "branches" } } },
        }),
      });
      expect(recipient).toBeDefined();
      return preparation.create.mock.calls.at(-1)![0];
    });
    const signal = new AbortController().signal;
    try {
      for (const registration of registrations) {
        await registration.prepare(signal);
      }
      expect(preparation.prepare).toHaveBeenCalledTimes(20);
      expect(release).toHaveBeenCalledTimes(20);
      expect(preparation.prepare.mock.calls.map(([input]) => input.sessionId)).toEqual(
        Array.from({ length: 20 }, (_, index) => `open-reader-${index}`),
      );
    } finally {
      for (const registration of registrations) {
        registration.clear();
      }
    }
  });

  it("retains independently live same-person openings without trusting expired or different-person proofs", () => {
    const branch = {
      agentId: "example",
      sessionKey: "agent:example:multi-opening",
      sessionId: "multi-opening",
      lifecycleRevision: "original",
      storePath: "/synthetic/agent.sqlite",
      root: {
        sessionKey: "agent:example:root",
        sessionId: "root",
        lifecycleRevision: "original",
      },
    };
    const participant = { type: "profile" as const, id: "example-person" };
    let firstLive = true;
    let secondLive = true;
    const first = {
      agentId: branch.agentId,
      sessionKey: branch.sessionKey,
      channelId: "webchat",
      accountId: "default",
      nativeChannelId: "private-opening",
      participant,
      assertCurrent() {
        if (!firstLive) {
          throw new Error("First opening closed");
        }
      },
    };
    const second = {
      ...first,
      assertCurrent() {
        if (!secondLive) {
          throw new Error("Second opening closed");
        }
      },
    };
    const register = (audience: typeof first) =>
      prepareConversationKnowledgeRecipient({
        branch,
        participant,
        audience,
        env: {},
        getRuntimeConfig: () => ({
          agents: { entries: { example: { conversationMode: "branches" } } },
        }),
      });
    const original = register(first);
    const scheduled = preparation.create.mock.calls[0]![0];
    try {
      expect(register(second)).toBe(original);
      expect(preparation.create).toHaveBeenCalledOnce();
      firstLive = false;
      expect(() => scheduled.assertCurrent()).not.toThrow();
      expect(() =>
        register({
          ...second,
          assertCurrent() {
            throw new Error("Expired candidate");
          },
        }),
      ).toThrow("Expired candidate");
      expect(() => scheduled.assertCurrent()).not.toThrow();
      expect(
        register({ ...second, participant: { type: "profile", id: "another-person" } }),
      ).toBeUndefined();
      secondLive = false;
      expect(() => scheduled.assertCurrent()).toThrow("no current private audience");
    } finally {
      scheduled.clear();
    }
  });

  it.each([false, true])(
    "retains the next source cursor without busy-retrying saturated storage (%s)",
    async (saturated) => {
      const branch = {
        agentId: "example",
        sessionKey: `agent:example:recipient-${saturated}`,
        sessionId: `recipient-${saturated}`,
        lifecycleRevision: "original",
        storePath: "/synthetic/agent.sqlite",
        root: {
          sessionKey: "agent:example:root",
          sessionId: "root",
          lifecycleRevision: "original",
        },
      };
      const participant = { type: "profile" as const, id: "example-person" };
      const release = vi.fn();
      const claimRelease = vi.fn();
      preparation.load.mockResolvedValue({
        entry: { sessionId: branch.sessionId, lifecycleRevision: branch.lifecycleRevision },
        databaseClaim: {
          kind: "worker",
          reader: {},
          assertCurrent() {},
          release: claimRelease,
        },
      });
      preparation.prepare.mockResolvedValue({
        nextSourceCursor: "pending-contribution",
        preparationSaturated: saturated,
        release,
      });
      const recipient = prepareConversationKnowledgeRecipient({
        branch,
        participant,
        audience: {
          agentId: branch.agentId,
          sessionKey: branch.sessionKey,
          channelId: "example-channel",
          accountId: "example-account",
          nativeChannelId: "example-recipient",
          participant,
          assertCurrent() {},
        },
        env: {},
        getRuntimeConfig: () => ({
          agents: { entries: { example: { conversationMode: "branches" } } },
        }),
      });
      expect(recipient).toBeDefined();
      const scheduled = preparation.create.mock.calls[0]![0];
      const signal = new AbortController().signal;
      expect(await scheduled.prepare(signal)).toBe(!saturated);
      expect(preparation.owner.request).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(claimRelease).toHaveBeenCalledOnce();
      preparation.owner.request.mockClear();
      expect(await scheduled.prepare(signal)).toBe(!saturated);
      expect(preparation.prepare.mock.calls[1]![0]).toMatchObject({
        sourceCursor: "pending-contribution",
        preparationOnly: true,
      });
      expect(preparation.owner.request).not.toHaveBeenCalled();
    },
  );
});
