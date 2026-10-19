import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createSessionEntryCreationOperation } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { admitSessionConversationBranch } from "../config/sessions/session-conversation-admission.js";
import type { prepareSessionGenerationFacts } from "../config/sessions/session-delivery-generation.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureClientVoiceAgentSessionEntry } from "./client-voice-session-initialization.js";

// Isolation boundary: the real native initialization owner has separate durable
// worker tests. These source-only tests verify Talk selects that owner and retains
// its exact branch/source facts, without generating a worker bundle.
const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  snapshot: vi.fn(),
  commit: vi.fn(),
  generation: vi.fn<typeof prepareSessionGenerationFacts>(),
  activate: vi.fn(),
  store: vi.fn(() => "/fixture/example/sessions.sqlite"),
}));
// mock-isolation: Exact-row enrollment/seed has durable owner tests; this adapter verifies native initialization selection.
vi.mock("../config/sessions/session-conversation-activation.js", () => ({
  prepareSessionConversationActivation: mocks.activate,
}));
// mock-isolation: generic native writes are outside this adapter-selection unit.
vi.mock("../config/sessions/session-accessor.js", () => ({ patchSessionEntryCore: mocks.patch }));
// mock-isolation: verify exact canonical initialization arguments without a generated worker.
vi.mock("../config/sessions/session-accessor.reset.js", () => ({
  loadReplySessionInitializationSnapshot: mocks.snapshot,
  commitReplySessionInitialization: mocks.commit,
}));
// mock-isolation: the native generation owner's exact COMMIT adoption is covered by worker tests.
vi.mock("../config/sessions/session-delivery-generation.js", () => ({
  prepareSessionGenerationFacts: mocks.generation,
}));
// mock-isolation: no physical session store is opened by this source-only fixture.
vi.mock("../config/sessions/session-store-path.js", () => ({
  resolveSessionStorePathForScope: mocks.store,
}));

function fixture() {
  mocks.activate.mockReset();
  mocks.activate.mockImplementation(async (params) => params.assertCurrent());
  const cfg: OpenClawConfig = {
    agents: { entries: { example: { conversationMode: "branches" } } },
    session: { mainKey: "primary" },
  };
  const target = {
    cfg,
    agentId: "example",
    sessionKey: "agent:example:browser-talk:call-example",
    assertCommitAllowed: vi.fn(),
    creation: {
      actor: { type: "human" as const, source: "profile" as const, id: "example-person" },
    },
  };
  const rootSessionKey = "agent:example:internal:conversation-root";
  const root: InternalSessionEntry = {
    sessionId: "root-original",
    lifecycleRevision: "root-lifecycle",
    updatedAt: 1,
    createdVia: "internal",
    createdActor: { type: "system", id: "conversation-root" },
    visibility: "draft",
    delivery: { kind: "none" },
    conversationTopology: { version: 1, role: "root" },
  };
  const state = {
    root: root as InternalSessionEntry | undefined,
    current: undefined as InternalSessionEntry | undefined,
  };
  const read = () => ({
    currentEntry: state.current,
    revision: "original-revision",
    readEntry: (key: string) => (key === rootSessionKey ? state.root : undefined),
  });
  let adopted = false;
  let publishBinding:
    | Parameters<Awaited<ReturnType<typeof prepareSessionGenerationFacts>>["bindCreation"]>[1]
    | undefined;
  const generation = {
    assertCurrent: vi.fn(),
    prepareRead: vi.fn(),
    readSessionSettings: vi.fn(() => ({})),
    release: vi.fn(),
    isCreationAdopted: vi.fn(() => adopted),
    bindCreation: vi.fn<Awaited<ReturnType<typeof prepareSessionGenerationFacts>>["bindCreation"]>(
      (_operation, publish) => {
        publishBinding = publish;
        return () => {};
      },
    ),
  };
  mocks.generation.mockResolvedValue(generation);
  const publishCreation = (entry: InternalSessionEntry) => {
    adopted = true;
    publishBinding?.({ sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision });
  };
  mocks.snapshot.mockImplementation(async () => read());
  mocks.commit.mockImplementation(async (params) => {
    params.bindCreation?.(createSessionEntryCreationOperation())();
    params.commitGuard();
    const entry = {
      ...params.sessionEntry,
      ...(params.branchRootSessionKey
        ? {
            conversationTopology: admitSessionConversationBranch({
              agentId: params.agentId,
              sessionKey: params.sessionKey,
              currentEntry: state.current,
              rootSessionKey: params.branchRootSessionKey,
              rootEntry: state.root,
            }),
          }
        : {}),
    };
    state.current = entry;
    publishCreation(entry);
    return { ok: true, sessionEntry: entry };
  });
  return { target, rootSessionKey, state, read, generation, publishCreation };
}

describe("native Talk startup conversation membership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses canonical branch initialization, never an unmarked generic patch or root/task spawn", async () => {
    const f = fixture();
    const sessionId = await ensureClientVoiceAgentSessionEntry(f.target);
    expect(mocks.store).toHaveBeenCalledWith(f.target, f.target.cfg);
    expect(mocks.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ relatedSessionKeys: [f.rootSessionKey] }),
      expect.objectContaining({ assertCurrent: expect.any(Function) }),
    );
    expect(mocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: f.target.sessionKey,
        branchRootSessionKey: f.rootSessionKey,
        expectedRevision: "original-revision",
        sessionEntry: expect.objectContaining({
          sessionId,
          createdVia: "talk",
          createdActor: f.target.creation.actor,
        }),
      }),
    );
    expect(mocks.commit.mock.calls[0]![0].sessionEntry).not.toHaveProperty("parentSessionKey");
    expect(mocks.commit.mock.calls[0]![0].sessionEntry).not.toHaveProperty("spawnedBy");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("adopts only the native creation publication before rechecking the original absent source", async () => {
    const f = fixture();
    let created = false;
    let admittedId: string | undefined;
    f.target.assertCommitAllowed.mockImplementation(() => {
      if (created && admittedId !== f.state.current?.sessionId) {
        throw new Error("Original absence was not adopted");
      }
    });
    const onCreatedSessionCommitted = vi.fn((binding: { sessionId: string }) => {
      admittedId = binding.sessionId;
    });
    mocks.commit.mockImplementationOnce(async (params) => {
      params.bindCreation(createSessionEntryCreationOperation())();
      params.commitGuard();
      const entry = { ...params.sessionEntry, lifecycleRevision: "committed-life" };
      created = true;
      f.state.current = entry;
      expect(onCreatedSessionCommitted).not.toHaveBeenCalled();
      f.publishCreation(entry);
      return { ok: true, sessionEntry: entry };
    });
    const sessionId = await ensureClientVoiceAgentSessionEntry({
      ...f.target,
      onCreatedSessionCommitted,
    });
    expect(onCreatedSessionCommitted).toHaveBeenCalledExactlyOnceWith({
      agentId: f.target.agentId,
      sessionKey: f.target.sessionKey,
      storePath: "/fixture/example/sessions.sqlite",
      sessionId,
      lifecycleRevision: "committed-life",
    });
    expect(f.generation.release).toHaveBeenCalledOnce();
  });

  it("does not treat a returned candidate as a creation publication", async () => {
    const f = fixture();
    const onCreatedSessionCommitted = vi.fn();
    mocks.commit.mockImplementationOnce(async (params) => {
      params.bindCreation(createSessionEntryCreationOperation())();
      params.commitGuard();
      return { ok: true, sessionEntry: params.sessionEntry };
    });
    await expect(
      ensureClientVoiceAgentSessionEntry({ ...f.target, onCreatedSessionCommitted }),
    ).rejects.toThrow("changed during startup");
    expect(onCreatedSessionCommitted).not.toHaveBeenCalled();
    expect(f.generation.release).toHaveBeenCalledOnce();
  });

  it("retains revocation after native creation publication and releases the same lease", async () => {
    const f = fixture();
    await expect(
      ensureClientVoiceAgentSessionEntry({
        ...f.target,
        onCreatedSessionCommitted: () => {
          f.target.assertCommitAllowed.mockImplementation(() => {
            throw new Error("Original requester revoked");
          });
        },
      }),
    ).rejects.toThrow("Original requester revoked");
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(f.generation.release).toHaveBeenCalledOnce();
  });

  it("keeps an existing admitted branch unchanged", async () => {
    const f = fixture();
    f.state.current = {
      sessionId: "existing-conversation",
      updatedAt: 1,
      conversationTopology: admitSessionConversationBranch({
        ...f.target,
        rootSessionKey: f.rootSessionKey,
        rootEntry: f.state.root,
      }),
    };
    await expect(ensureClientVoiceAgentSessionEntry(f.target)).resolves.toBe(
      "existing-conversation",
    );
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("retains the original direct-surface fact without inventing a user contribution", async () => {
    const f = fixture();
    await ensureClientVoiceAgentSessionEntry({ ...f.target, chatType: "direct" });
    const entry = mocks.commit.mock.calls[0]![0].sessionEntry;
    expect(entry.chatType).toBe("direct");
    expect(entry.participantCount ?? 0).toBe(0);
    expect(entry.participants ?? []).toEqual([]);
  });

  it("does not reclassify an existing group when a direct connection selects it", async () => {
    const f = fixture();
    f.state.current = {
      sessionId: "existing-group",
      updatedAt: 1,
      chatType: "group",
      conversationTopology: admitSessionConversationBranch({
        ...f.target,
        rootSessionKey: f.rootSessionKey,
        rootEntry: f.state.root,
      }),
    };
    await expect(
      ensureClientVoiceAgentSessionEntry({ ...f.target, chatType: "direct" }),
    ).resolves.toBe("existing-group");
    expect(f.state.current.chatType).toBe("group");
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("keeps the same new-row surface classification on the native-mode initialization path", async () => {
    const f = fixture();
    f.target.cfg.agents!.entries!.example!.conversationMode = "native";
    f.state.root = undefined;
    const onCreatedSessionCommitted = vi.fn();
    const sessionId = await ensureClientVoiceAgentSessionEntry({
      ...f.target,
      chatType: "direct",
      onCreatedSessionCommitted,
    });
    expect(mocks.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ relatedSessionKeys: [] }),
      expect.objectContaining({ assertCurrent: expect.any(Function) }),
    );
    expect(mocks.commit).toHaveBeenCalledOnce();
    const committed = mocks.commit.mock.calls[0]![0];
    expect(committed).not.toHaveProperty("branchRootSessionKey");
    expect(committed.sessionEntry.chatType).toBe("direct");
    expect(committed.sessionEntry.participants ?? []).toEqual([]);
    expect(f.state.current).not.toHaveProperty("conversationTopology");
    expect(onCreatedSessionCommitted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId }),
    );
    expect(f.generation.isCreationAdopted).toHaveReturnedWith(true);
    expect(f.generation.release).toHaveBeenCalledOnce();
    expect(mocks.activate).toHaveBeenCalledTimes(2);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("activates an absent native target only after its real creation has adopted the original source", async () => {
    const f = fixture();
    f.target.cfg.agents!.entries!.example!.conversationMode = "native";
    let admittedId: string | undefined;
    const order: string[] = [];
    f.target.assertCommitAllowed.mockImplementation(() => {
      if (f.state.current && admittedId !== f.state.current.sessionId) {
        throw new Error("Original absence was not adopted");
      }
    });
    const onCreatedSessionCommitted = vi.fn((binding: { sessionId: string }) => {
      expect(f.state.current?.sessionId).toBe(binding.sessionId);
      admittedId = binding.sessionId;
      order.push("published");
    });
    mocks.activate.mockImplementation(async (params) => {
      params.assertCurrent();
      expect(params).not.toHaveProperty("sessionId");
      if (!f.state.current) {
        order.push("activate-absent");
        expect(onCreatedSessionCommitted).not.toHaveBeenCalled();
        return;
      }
      order.push("activate-committed");
      expect(onCreatedSessionCommitted).toHaveBeenCalledOnce();
      expect(f.state.current.sessionId).toBe(admittedId);
      f.state.current = {
        ...f.state.current,
        conversationTopology: admitSessionConversationBranch({
          ...f.target,
          rootSessionKey: f.rootSessionKey,
          rootEntry: f.state.root,
        }),
      };
      params.assertCurrent();
    });
    mocks.commit.mockImplementationOnce(async (params) => {
      expect(params).not.toHaveProperty("branchRootSessionKey");
      params.bindCreation(createSessionEntryCreationOperation())();
      params.commitGuard();
      order.push("commit");
      const entry = { ...params.sessionEntry, lifecycleRevision: "native-committed-life" };
      f.state.current = entry;
      expect(onCreatedSessionCommitted).not.toHaveBeenCalled();
      f.publishCreation(entry);
      return { ok: true, sessionEntry: entry };
    });
    const sessionId = await ensureClientVoiceAgentSessionEntry({
      ...f.target,
      onCreatedSessionCommitted,
    });
    expect(order).toEqual(["activate-absent", "commit", "published", "activate-committed"]);
    expect(onCreatedSessionCommitted).toHaveBeenCalledExactlyOnceWith({
      agentId: f.target.agentId,
      sessionKey: f.target.sessionKey,
      storePath: "/fixture/example/sessions.sqlite",
      sessionId,
      lifecycleRevision: "native-committed-life",
    });
    expect(f.state.current?.conversationTopology).toEqual(
      expect.objectContaining({ role: "branch", rootSessionId: "root-original" }),
    );
    expect(f.generation.release).toHaveBeenCalledOnce();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("reuses exact existing history after the activation owner admits its membership", async () => {
    const f = fixture();
    f.state.current = { sessionId: "existing-native-conversation", updatedAt: 1 };
    mocks.activate.mockImplementationOnce(async (params) => {
      params.assertCurrent();
      f.state.current = {
        ...f.state.current!,
        conversationTopology: admitSessionConversationBranch({
          ...f.target,
          rootSessionKey: f.rootSessionKey,
          rootEntry: f.state.root,
        }),
      };
    });
    await expect(ensureClientVoiceAgentSessionEntry(f.target)).resolves.toBe(
      "existing-native-conversation",
    );
    expect(mocks.activate).toHaveBeenCalledTimes(2);
    for (const [params] of mocks.activate.mock.calls) {
      expect(params).toEqual(
        expect.objectContaining({
          cfg: f.target.cfg,
          agentId: f.target.agentId,
          sessionKey: f.target.sessionKey,
          assertCurrent: expect.any(Function),
        }),
      );
      params.assertCurrent();
    }
    f.target.assertCommitAllowed.mockImplementation(() => {
      throw new Error("Original requester revoked");
    });
    for (const [params] of mocks.activate.mock.calls) {
      expect(() => params.assertCurrent()).toThrow("Original requester revoked");
    }
    expect(f.state.current.updatedAt).toBe(1);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("still refuses an unmarked row if the activation owner did not admit it", async () => {
    const f = fixture();
    f.state.current = { sessionId: "legacy-conversation", updatedAt: 1 };
    await expect(ensureClientVoiceAgentSessionEntry(f.target)).rejects.toThrow(
      "explicit branch admission",
    );
    expect(f.state.current).toEqual({ sessionId: "legacy-conversation", updatedAt: 1 });
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("refuses a missing headless root without creating one", async () => {
    const f = fixture();
    f.state.root = undefined;
    await expect(ensureClientVoiceAgentSessionEntry(f.target)).rejects.toThrow(
      "root is not admitted",
    );
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("does not use a native main row as the internal root", async () => {
    const f = fixture();
    mocks.snapshot.mockResolvedValue({
      ...f.read(),
      readEntry: (key: string) => (key === "agent:example:primary" ? f.state.root : undefined),
    });
    await expect(ensureClientVoiceAgentSessionEntry(f.target)).rejects.toThrow(
      "root is not admitted",
    );
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("rejects a main-key collision or global scope selected during snapshot preparation", async () => {
    const f = fixture();
    mocks.snapshot.mockImplementationOnce(async () => {
      f.target.cfg.session!.mainKey = "internal:conversation-root";
      return f.read();
    });
    await expect(ensureClientVoiceAgentSessionEntry(f.target)).rejects.toThrow("collides");
    f.target.cfg.session = { mainKey: "primary" };
    mocks.snapshot.mockImplementationOnce(async () => {
      f.target.cfg.session!.scope = "global";
      return f.read();
    });
    await expect(ensureClientVoiceAgentSessionEntry(f.target)).rejects.toThrow(
      "configuration changed",
    );
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("retains original prepared source predicates at the native writer boundary", async () => {
    const f = fixture();
    const source: SessionSourceAssertion = Object.assign(vi.fn(), {
      prepareSessionSource: vi.fn(),
    });
    await ensureClientVoiceAgentSessionEntry({ ...f.target, assertCommitAllowed: source });
    expect(mocks.commit.mock.calls[0]![0].contextSourceAuthority).toBe(source);
    expect(source).toHaveBeenCalled();
  });

  it("refuses revoked original authority after snapshot preparation without a write", async () => {
    const f = fixture();
    const deferred = createDeferred<ReturnType<typeof f.read>>();
    mocks.snapshot.mockReturnValue(deferred.promise);
    const pending = ensureClientVoiceAgentSessionEntry(f.target);
    f.target.assertCommitAllowed.mockImplementation(() => {
      throw new Error("original source expired");
    });
    deferred.resolve(f.read());
    await expect(pending).rejects.toThrow("original source expired");
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("refuses deadline or mode changes before writing", async () => {
    const f = fixture();
    await expect(
      ensureClientVoiceAgentSessionEntry({ ...f.target, deadlineAt: Date.now() - 1 }),
    ).rejects.toThrow("expired during startup");
    expect(mocks.snapshot).not.toHaveBeenCalled();
    mocks.snapshot.mockImplementation(async () => {
      f.target.cfg.agents!.entries!.example!.conversationMode = "native";
      return f.read();
    });
    await expect(ensureClientVoiceAgentSessionEntry(f.target)).rejects.toThrow(
      "configuration changed",
    );
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("does not overwrite a concurrently changed target or retry native work", async () => {
    const f = fixture();
    mocks.commit.mockResolvedValue({ ok: false, reason: "stale-snapshot", revision: "successor" });
    await expect(ensureClientVoiceAgentSessionEntry(f.target)).rejects.toThrow(
      "changed during startup",
    );
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});
