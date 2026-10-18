import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { admitSessionConversationBranch } from "../config/sessions/session-conversation-admission.js";
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
  store: vi.fn(() => "/fixture/example/sessions.sqlite"),
}));
// mock-isolation: generic native writes are outside this adapter-selection unit.
vi.mock("../config/sessions/session-accessor.js", () => ({ patchSessionEntryCore: mocks.patch }));
// mock-isolation: verify exact canonical initialization arguments without a generated worker.
vi.mock("../config/sessions/session-accessor.reset.js", () => ({
  loadReplySessionInitializationSnapshot: mocks.snapshot,
  commitReplySessionInitialization: mocks.commit,
}));
// mock-isolation: no physical session store is opened by this source-only fixture.
vi.mock("../config/sessions/session-store-path.js", () => ({
  resolveSessionStorePathForScope: mocks.store,
}));

function fixture() {
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
  const rootSessionKey = "agent:example:primary";
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
  mocks.snapshot.mockImplementation(async () => read());
  mocks.commit.mockImplementation(async (params) => {
    params.commitGuard();
    const topology = admitSessionConversationBranch({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      currentEntry: state.current,
      rootSessionKey: params.branchRootSessionKey,
      rootEntry: state.root,
    });
    return { ok: true, sessionEntry: { ...params.sessionEntry, conversationTopology: topology } };
  });
  return { target, rootSessionKey, state, read };
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
    mocks.patch.mockImplementation(async (_target, update) => {
      const created = update(undefined, { existingEntry: undefined });
      expect(created.chatType).toBe("direct");
      expect(created.participants ?? []).toEqual([]);
      expect(created).not.toHaveProperty("conversationTopology");
      // The native patch owner supplies the row ID; the callback only proposes metadata.
      return { ...created, sessionId: "native-created" };
    });
    await expect(
      ensureClientVoiceAgentSessionEntry({ ...f.target, chatType: "direct" }),
    ).resolves.toEqual(expect.any(String));
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("refuses unmarked existing history rather than implicitly migrating it", async () => {
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
