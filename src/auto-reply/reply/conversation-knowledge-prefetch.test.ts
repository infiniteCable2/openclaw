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
// mock-isolation: Shared root summaries have their own scheduling and authority tests.
vi.mock("./conversation-knowledge-checkpoint-owner.js", () => ({
  registerConversationKnowledgeCheckpointOwner: () => ({
    request: vi.fn(),
    pausePreparation: () => () => {},
    latest: () => undefined,
    projection: () => ({ tail: [] }),
    close: async () => {},
  }),
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
  createConversationKnowledgeSourceCache: () => ({
    clear: vi.fn(),
    retainCleanup: vi.fn(),
    forgetCleanup: vi.fn(),
    retryCleanup: vi.fn(),
    diagnosticPreparedFrontiers: () => [],
    diagnosticCapacity: () => ({}),
  }),
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
  preparation.owner.close.mockResolvedValue(undefined);
});

describe("recipient preparation scheduling", () => {
  function retainedOpening() {
    const branch = {
      agentId: "example",
      sessionKey: "agent:example:retained-opening",
      sessionId: "retained-opening",
      lifecycleRevision: "original",
      storePath: "/synthetic/agent.sqlite",
      root: {
        sessionKey: "agent:example:root",
        sessionId: "root",
        lifecycleRevision: "original",
      },
    };
    const participant = { type: "profile" as const, id: "example-person" };
    const source = Object.freeze({});
    const revocation = new AbortController();
    let originalCurrent = true;
    const releases: ReturnType<typeof vi.fn>[] = [];
    const open = (endpoint?: { source: object; sourceClosed: AbortSignal }) => {
      let retained = true;
      const fields = {
        agentId: branch.agentId,
        sessionKey: branch.sessionKey,
        channelId: "webchat",
        accountId: "default",
        nativeChannelId: "original-endpoint",
        participant,
      };
      const release = vi.fn(() => {
        retained = false;
      });
      releases.push(release);
      const retain = vi.fn(() => [
        {
          source: endpoint?.source ?? source,
          sourceClosed: endpoint?.sourceClosed,
          signal: revocation.signal,
          audience: {
            ...fields,
            assertCurrent() {
              revocation.signal.throwIfAborted();
              if (!retained) {
                throw new Error("Retained opening released");
              }
            },
          },
          release,
        },
      ]);
      return {
        ...fields,
        assertCurrent() {
          if (!originalCurrent) {
            throw new Error("Original turn ended");
          }
        },
        retain,
      };
    };
    const register = (audience = open()) =>
      prepareConversationKnowledgeRecipient({
        branch,
        participant,
        audience,
        env: {},
        getRuntimeConfig: () => ({
          agents: { entries: { example: { conversationMode: "branches" } } },
        }),
      });
    return {
      branch,
      open,
      register,
      releases,
      revocation,
      endTurn() {
        originalCurrent = false;
      },
    };
  }

  it("retains an idle opening independently and replaces its native hold once per endpoint", () => {
    const f = retainedOpening();
    const recipient = f.register();
    const scheduled = preparation.create.mock.calls[0]![0];
    try {
      for (let index = 0; index < 3; index++) {
        expect(f.register()).toBe(recipient);
      }
      expect(preparation.create).toHaveBeenCalledOnce();
      expect(f.releases.slice(0, 3).map((release) => release.mock.calls.length)).toEqual([1, 1, 1]);
      expect(f.releases[3]).not.toHaveBeenCalled();
      f.endTurn();
      expect(() => scheduled.assertCurrent()).not.toThrow();
      const before = preparation.owner.request.mock.calls.length;
      f.revocation.abort(new Error("Native source revoked"));
      expect(preparation.owner.request).toHaveBeenCalledTimes(before + 1);
      expect(() => scheduled.assertCurrent()).toThrow("no current private audience");
      expect(f.releases[3]).toHaveBeenCalledOnce();
    } finally {
      scheduled.clear();
    }
  });

  it("keeps a disconnected idle opening until a valid reconnect replaces it", () => {
    const f = retainedOpening();
    let closed = new AbortController();
    const recipient = f.register(
      f.open({ source: Object.freeze({}), sourceClosed: closed.signal }),
    );
    const scheduled = preparation.create.mock.calls[0]![0];
    try {
      for (let index = 0; index < 5; index++) {
        closed.abort();
        expect(() => scheduled.assertCurrent()).not.toThrow();
        expect(f.releases[index]).not.toHaveBeenCalled();
        closed = new AbortController();
        expect(f.register(f.open({ source: Object.freeze({}), sourceClosed: closed.signal }))).toBe(
          recipient,
        );
        expect(f.releases[index]).toHaveBeenCalledOnce();
        expect(f.releases[index + 1]).not.toHaveBeenCalled();
      }
    } finally {
      scheduled.clear();
    }
    expect(f.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it.each(["reset", "deleted", "archived"])(
    "retires the exact recipient and native holds when %s",
    async (change) => {
      const f = retainedOpening();
      f.register();
      const scheduled = preparation.create.mock.calls[0]![0];
      const entry =
        change === "deleted"
          ? undefined
          : {
              sessionId: f.branch.sessionId,
              lifecycleRevision: change === "reset" ? "new-life" : "original",
              ...(change === "archived" ? { archivedAt: 1 } : {}),
            };
      const release = vi.fn();
      preparation.load.mockResolvedValue({
        entry,
        databaseClaim: { kind: "worker", reader: {}, assertCurrent() {}, release },
      });
      preparation.owner.close.mockImplementation(async () => {
        scheduled.clear();
        await scheduled.settle?.();
      });
      try {
        expect(await scheduled.prepare(new AbortController().signal)).toBe(false);
        expect(preparation.prepare).not.toHaveBeenCalled();
        expect(preparation.owner.close).toHaveBeenCalledOnce();
        expect(f.releases[0]).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
      } finally {
        scheduled.clear();
      }
    },
  );

  it("does not install new native holds into an already closed recipient", () => {
    const f = retainedOpening();
    const first = f.register();
    const old = preparation.create.mock.calls[0]![0];
    preparation.owner.assertCurrent.mockImplementationOnce(() => {
      throw new Error("Closed owner");
    });
    preparation.owner.close.mockImplementationOnce(async () => old.clear());
    const incoming = f.open();
    const replacement = f.register(incoming);
    const current = preparation.create.mock.calls[1]![0];
    try {
      expect(replacement).not.toBe(first);
      expect(incoming.retain).toHaveBeenCalledOnce();
      expect(f.releases[0]).toHaveBeenCalledOnce();
      expect(f.releases[1]).not.toHaveBeenCalled();
    } finally {
      current.clear();
    }
  });

  it("releases native audience custody if the recipient owner cannot be initialized", () => {
    const f = retainedOpening();
    preparation.create.mockImplementationOnce(() => {
      throw new Error("Synthetic owner initialization failed");
    });
    expect(() => f.register()).toThrow("Synthetic owner initialization failed");
    expect(f.releases[0]).toHaveBeenCalledOnce();
  });

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
