import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";

const boundary = vi.hoisted(() => ({
  load: vi.fn(),
  branch: vi.fn(),
  seed: vi.fn(),
  register: vi.fn(),
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

import { openConversationKnowledgeRecipient } from "./conversation-knowledge-open.js";

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
            : params.getRuntimeConfig,
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
