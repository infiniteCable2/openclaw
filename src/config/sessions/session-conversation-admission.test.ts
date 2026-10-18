import { describe, expect, it } from "vitest";
import { admitSessionConversationBranch } from "./session-conversation-admission.js";
import type { InternalSessionEntry } from "./types.js";

function fixture() {
  const rootEntry: InternalSessionEntry = {
    sessionId: "root-original",
    lifecycleRevision: "root-lifecycle",
    updatedAt: 1,
    createdVia: "internal",
    createdActor: { type: "system", id: "conversation-root" },
    visibility: "draft",
    delivery: { kind: "none" },
    conversationTopology: { version: 1, role: "root" },
  };
  return {
    agentId: "example",
    sessionKey: "agent:example:matrix:direct:peer",
    rootSessionKey: "agent:example:main",
    rootEntry,
  };
}

describe("conversation branch admission", () => {
  it("binds an equal conversation to an admitted root without conferring history or task rights", () => {
    const f = fixture();
    const topology = admitSessionConversationBranch(f);
    expect(topology).toEqual({
      version: 1,
      role: "branch",
      rootSessionKey: f.rootSessionKey,
      rootSessionId: "root-original",
      rootSessionLifecycleRevision: "root-lifecycle",
    });
    expect(topology).not.toHaveProperty("spawnedBy");
    expect(topology).not.toHaveProperty("parentSessionKey");
    const currentEntry: InternalSessionEntry = {
      sessionId: "branch-original",
      updatedAt: 2,
      conversationTopology: topology,
    };
    expect(admitSessionConversationBranch({ ...f, currentEntry })).toEqual(topology);
    f.rootEntry.sessionId = "new-root";
    expect(topology.rootSessionId).toBe("root-original");
    expect(() => admitSessionConversationBranch({ ...f, currentEntry })).toThrow(
      "incarnation changed",
    );
  });

  it.each([
    { conversationTopology: undefined },
    { createdActor: { type: "human", source: "profile", id: "example-reader" } },
    { visibility: "shared" },
    { visibility: undefined },
    { delivery: { kind: "internal" } },
    { delivery: undefined },
    { parentSessionKey: "agent:example:another-parent" },
    { spawnedBy: "agent:example:task" },
    { incognito: true },
    { initializationPending: true },
    { archivedAt: 1 },
    { pendingProjectGitUrl: "https://example.test/project.git" },
    { lifecycleRevision: undefined },
    { publicShare: { id: "public", sessionId: "root-original", createdAt: 1 } },
  ] satisfies Partial<InternalSessionEntry>[])(
    "rejects an unadmitted or externally published root %j",
    (change) => {
      const f = fixture();
      expect(() =>
        admitSessionConversationBranch({ ...f, rootEntry: { ...f.rootEntry, ...change } }),
      ).toThrow("root is not admitted");
    },
  );

  it("never silently enrolls an existing unmarked conversation or adopts another root role", () => {
    const f = fixture();
    expect(() =>
      admitSessionConversationBranch({ ...f, currentEntry: { sessionId: "legacy", updatedAt: 1 } }),
    ).toThrow("explicit branch admission");
    expect(() => admitSessionConversationBranch({ ...f, currentEntry: f.rootEntry })).toThrow(
      "incarnation changed",
    );
    expect(() => admitSessionConversationBranch({ ...f, rootEntry: undefined })).toThrow(
      "root is not admitted",
    );
  });

  it.each(["agent:another:main", "agent:example:subagent:task", "agent:example:main"])(
    "refuses foreign/task/root branch targets %s",
    (sessionKey) => {
      expect(() => admitSessionConversationBranch({ ...fixture(), sessionKey })).toThrow(
        "same-agent, non-task target",
      );
    },
  );
});
