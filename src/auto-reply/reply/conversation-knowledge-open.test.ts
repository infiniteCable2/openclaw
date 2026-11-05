import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";

const boundary = vi.hoisted(() => ({
  load: vi.fn(),
  branch: vi.fn(),
  seed: vi.fn(),
  register: vi.fn(),
  root: vi.fn(),
}));
// mock-isolation: Verify opening custody without starting native workers or process-wide readers.
vi.mock("../../config/sessions/session-accessor.sqlite-entry-admission.js", () => ({
  loadSessionEntryForAdmission: boundary.load,
}));
// mock-isolation: Native topology validation has its own real-store tests; this fixture tests handoff.
vi.mock("../../config/sessions/conversation-knowledge-store.js", () => ({
  readConversationKnowledgeBranch: boundary.branch,
}));
// mock-isolation: No historical transcript or seed writes are needed for the opening-order contract.
vi.mock("../../config/sessions/conversation-knowledge-seed.js", () => ({
  ensureConversationKnowledgeSeed: boundary.seed,
}));
// mock-isolation: Registration must not start a detached database owner in this boundary fixture.
vi.mock("./conversation-knowledge-prefetch.js", () => ({
  prepareConversationKnowledgeRecipient: boundary.register,
}));
// mock-isolation: Test startup enrollment without launching the existing detached RootOwner.
vi.mock("./conversation-knowledge-checkpoint-owner.js", () => ({
  registerConversationKnowledgeCheckpointOwner: boundary.root,
}));

import {
  openConversationKnowledgeRecipient,
  openConversationKnowledgeRoot,
} from "./conversation-knowledge-open.js";

const branch = {
  agentId: "example",
  sessionKey: "agent:example:private-chat",
  sessionId: "original-conversation",
  lifecycleRevision: "original-lifecycle",
  storePath: "/synthetic/agent.sqlite",
  root: {
    sessionKey: "agent:example:root",
    sessionId: "root",
    lifecycleRevision: "root-lifecycle",
  },
};

function fixture() {
  const participant = { type: "profile" as const, id: "example-person" };
  const audience: ConversationPrivateAudience = {
    ...branch,
    channelId: "webchat",
    accountId: "default",
    nativeChannelId: branch.sessionKey,
    participant,
    assertCurrent: vi.fn<() => void>(),
  };
  const release = vi.fn(async () => {});
  const reader = { database: { env: { OPENCLAW_STATE_DIR: "/synthetic/state" } } };
  boundary.load.mockResolvedValue({
    entry: { sessionId: branch.sessionId },
    databaseClaim: { kind: "worker", reader, assertCurrent() {}, release },
  });
  boundary.branch.mockResolvedValue(branch);
  boundary.seed.mockResolvedValue({ status: "seeded", recorded: 0, skipped: 0 });
  return {
    release,
    reader,
    params: {
      target: branch,
      participant,
      audience,
      getRuntimeConfig() {
        return {
          agents: { entries: { [this.target.agentId]: { conversationMode: "branches" as const } } },
        };
      },
    },
  };
}

beforeEach(() => {
  for (const mock of Object.values(boundary)) {
    mock.mockReset();
  }
});

describe("opening a private conversation recipient", () => {
  it("restores root and recipient preparation before input without creating or backfilling history", async () => {
    const { params, release, reader } = fixture();
    const close = vi.fn(async () => {});
    boundary.root.mockReturnValue({ close });
    boundary.load.mockResolvedValue({
      entry: {
        sessionId: branch.sessionId,
        visibility: "draft",
        participantCount: 1,
        participants: [{ identity: params.participant }],
      },
      databaseClaim: { kind: "worker", reader, assertCurrent() {}, release },
    });
    const registration = await openConversationKnowledgeRoot({
      ...params,
      target: {
        agentId: branch.agentId,
        sessionKey: branch.sessionKey,
        storePath: branch.storePath,
      },
    });
    expect(registration).toEqual({ close });
    expect(boundary.root).toHaveBeenCalledWith(
      expect.objectContaining({
        branch,
        participant: params.participant,
        audience: params.audience,
      }),
    );
    expect(boundary.seed).not.toHaveBeenCalled();
    expect(boundary.register).toHaveBeenCalledWith(
      expect.objectContaining({
        branch,
        participant: params.participant,
        audience: params.audience,
      }),
    );
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      boundary.register.mock.invocationCallOrder[0]!,
    );
    expect(release).toHaveBeenCalledOnce();
    await registration?.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["missing", "public", "public-share", "incognito", "archived"])(
    "does not enroll a startup broker with unproven private current state (%s)",
    async (state) => {
      const { params, release, reader } = fixture();
      const entry = {
        sessionId: branch.sessionId,
        visibility: state === "public" ? "public" : "draft",
        publicShare: state === "public-share" ? {} : undefined,
        incognito: state === "incognito",
        archivedAt: state === "archived" ? 1 : undefined,
        participantCount: 1,
        participants: [{ identity: params.participant }],
      };
      boundary.load.mockResolvedValue({
        entry: state === "missing" ? undefined : entry,
        databaseClaim: { kind: "worker", reader, assertCurrent() {}, release },
      });
      await expect(openConversationKnowledgeRoot(params)).resolves.toBeUndefined();
      expect(boundary.root).not.toHaveBeenCalled();
      expect(boundary.seed).not.toHaveBeenCalled();
      expect(boundary.register).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each(["old-remote", "shared-owner", "different-person", "partial-roster"])(
    "prepares the current attested person's view without relabeling historical %s metadata",
    async (history) => {
      const { params, reader, release } = fixture();
      const close = vi.fn(async () => {});
      boundary.root.mockReturnValue({ close });
      boundary.load.mockResolvedValue({
        entry: {
          sessionId: branch.sessionId,
          visibility: "draft",
          participantCount: history === "partial-roster" ? 2 : 1,
          participants: [
            {
              identity:
                history === "old-remote"
                  ? {
                      type: "remote",
                      pluginId: "example",
                      domain: "example.test",
                      idKind: "user",
                      id: "old-person",
                    }
                  : {
                      type: "profile",
                      id: history === "shared-owner" ? "gateway-owner" : "other-person",
                    },
            },
          ],
        },
        databaseClaim: { kind: "worker", reader, assertCurrent() {}, release },
      });
      const registration = await openConversationKnowledgeRoot(params);
      expect(registration).toEqual({ close });
      expect(boundary.root).toHaveBeenCalledWith(
        expect.objectContaining({ participant: params.participant, audience: params.audience }),
      );
      expect(boundary.seed).not.toHaveBeenCalled();
      expect(boundary.register).toHaveBeenCalledWith(
        expect.objectContaining({
          branch,
          participant: params.participant,
          audience: params.audience,
        }),
      );
      await registration?.close();
    },
  );

  it("refuses a person link revoked while acquiring the startup reader", async () => {
    const { params, reader, release } = fixture();
    boundary.load.mockImplementation(async () => {
      vi.mocked(params.audience.assertCurrent).mockImplementation(() => {
        throw new Error("original person link revoked");
      });
      return {
        entry: { sessionId: branch.sessionId, visibility: "draft" },
        databaseClaim: { kind: "worker", reader, assertCurrent() {}, release },
      };
    });
    await expect(openConversationKnowledgeRoot(params)).rejects.toThrow("person link revoked");
    expect(boundary.root).not.toHaveBeenCalled();
    expect(boundary.seed).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("closes a root whose native reader fails to release after registration", async () => {
    const { params, reader } = fixture();
    const close = vi.fn(async () => {});
    boundary.root.mockReturnValue({ close });
    boundary.load.mockResolvedValue({
      entry: {
        sessionId: branch.sessionId,
        visibility: "draft",
        participantCount: 1,
        participants: [{ identity: params.participant }],
      },
      databaseClaim: {
        kind: "worker",
        reader,
        assertCurrent() {},
        release: async () => {
          throw new Error("reader cleanup deferred");
        },
      },
    });
    await expect(openConversationKnowledgeRoot(params)).rejects.toThrow("reader cleanup deferred");
    expect(close).toHaveBeenCalledOnce();
    expect(boundary.register).not.toHaveBeenCalled();
  });

  it("seeds and registers before any input, releasing only its native read hold", async () => {
    const { params, release, reader } = fixture();
    await openConversationKnowledgeRecipient(params);
    expect(boundary.seed).toHaveBeenCalledWith(
      expect.objectContaining({ reader, sessionId: branch.sessionId }),
    );
    expect(boundary.register).toHaveBeenCalledWith({
      branch,
      participant: params.participant,
      audience: params.audience,
      env: reader.database.env,
      getRuntimeConfig: expect.any(Function),
    });
    expect(boundary.register.mock.calls[0]![0].getRuntimeConfig()).toEqual(
      params.getRuntimeConfig(),
    );
    expect(boundary.seed.mock.invocationCallOrder[0]).toBeLessThan(
      boundary.register.mock.invocationCallOrder[0]!,
    );
    expect(boundary.register.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    );
    expect(release).toHaveBeenCalledOnce();
    expect(() => params.audience.assertCurrent()).not.toThrow();
  });

  it.each(["absent", "different-person", "different-target", "native"] as const)(
    "does not read or seed an ineligible recipient (%s)",
    async (reason) => {
      const { params } = fixture();
      await openConversationKnowledgeRecipient({
        ...params,
        audience:
          reason === "absent"
            ? undefined
            : reason === "different-target"
              ? { ...params.audience, sessionKey: "agent:example:other" }
              : params.audience,
        participant:
          reason === "different-person"
            ? { type: "profile", id: "different-person" }
            : params.participant,
        getRuntimeConfig:
          reason === "native"
            ? () => ({ agents: { entries: { example: { conversationMode: "native" } } } })
            : () => params.getRuntimeConfig(),
      });
      expect(boundary.load).not.toHaveBeenCalled();
      expect(boundary.seed).not.toHaveBeenCalled();
      expect(boundary.register).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "successor", "unenrolled", "pending"] as const)(
    "never registers unresolved or replaced history (%s)",
    async (state) => {
      const { params, release, reader } = fixture();
      if (state === "missing" || state === "successor") {
        boundary.load.mockResolvedValue({
          entry: state === "missing" ? undefined : { sessionId: "successor" },
          databaseClaim: { kind: "worker", reader, assertCurrent() {}, release },
        });
      } else if (state === "unenrolled") {
        boundary.branch.mockResolvedValue(undefined);
      } else {
        boundary.seed.mockResolvedValue({
          status: "pending",
          reason: "source-capacity",
          recorded: 0,
          skipped: 0,
        });
      }
      const opened = openConversationKnowledgeRecipient(params);
      if (state === "successor") {
        await expect(opened).rejects.toThrow("recipient changed");
      } else {
        await opened;
      }
      expect(boundary.register).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("rechecks original audience after awaited seed work", async () => {
    const { params, release } = fixture();
    boundary.seed.mockImplementation(async () => {
      vi.mocked(params.audience.assertCurrent).mockImplementation(() => {
        throw new Error("original audience revoked");
      });
      return { status: "seeded", recorded: 0, skipped: 0 };
    });
    await expect(openConversationKnowledgeRecipient(params)).rejects.toThrow("audience revoked");
    expect(boundary.register).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
