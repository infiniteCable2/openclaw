import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { resetSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import type { SessionConversationTopology } from "./session-conversation-topology.js";
import type { InternalSessionEntry } from "./types.js";

let state: OpenClawTestState;
let database: ReturnType<typeof openOpenClawAgentDatabase>;
let nextId = 0;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "conversation-topology" });
  database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
});
afterAll(async () => {
  await state.cleanup();
});

function write(sessionKey: string, entry: InternalSessionEntry) {
  runOpenClawAgentWriteTransaction((current) => writeSessionEntry(current, sessionKey, entry), {
    agentId: "main",
    path: database.path,
    env: state.env,
  });
}

function read(sessionKey: string) {
  return readExactSessionEntryRow(database, sessionKey);
}

function binding(): SessionConversationTopology {
  return {
    version: 1,
    role: "branch",
    rootSessionKey: "agent:main:main",
    rootSessionId: "root-original",
    rootSessionLifecycleRevision: "root-lifecycle-original",
  };
}

async function reset(
  writer: "single" | "batched",
  sessionKey: string,
  entry: InternalSessionEntry,
) {
  if (writer === "single") {
    const result = await resetSessionEntryLifecycle({
      agentId: "main",
      storePath: database.path,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => entry,
    });
    return result.nextEntry;
  }
  await applySessionEntryLifecycleMutation({
    agentId: "main",
    storePath: database.path,
    skipMaintenance: true,
    upserts: [
      {
        sessionKey,
        buildEntry: () => entry,
        resetBoundary: { context: "clear", reason: "reset", cwd: "/synthetic/workspace" },
      },
    ],
  });
  return read(sessionKey)!.entry;
}

describe("native conversation topology storage", () => {
  it.each([{ version: 1, role: "root" } as const, binding()])(
    "roundtrips $role metadata through native entry_json without task lineage",
    (conversationTopology) => {
      const key = `agent:main:topology-roundtrip-${++nextId}`;
      write(key, { sessionId: `roundtrip-${nextId}`, updatedAt: 1, conversationTopology });
      const selected = read(key)!;
      expect(JSON.parse(selected.row.entry_json).conversationTopology).toEqual(
        conversationTopology,
      );
      expect(selected.entry.conversationTopology).toEqual(conversationTopology);
      expect(selected.entry.spawnedBy).toBeUndefined();
      expect(selected.entry.parentSessionKey).toBeUndefined();
      expect(selected.entry.forkSource).toBeUndefined();
    },
  );

  it.each(["single", "batched"] as const)(
    "retains only the authoritative target binding during a %s same-node reset",
    async (writer) => {
      const key = `agent:main:topology-reset-${++nextId}`;
      const original = binding();
      write(key, {
        sessionId: `before-${nextId}`,
        lifecycleRevision: "before",
        updatedAt: 1,
        conversationTopology: original,
      });
      const next = await reset(writer, key, {
        sessionId: `after-${nextId}`,
        lifecycleRevision: "after",
        updatedAt: 2,
        conversationTopology: { version: 1, role: "root" },
      });
      expect(next.conversationTopology).toEqual(original);
      expect(read(key)?.entry.conversationTopology).toEqual(original);
    },
  );

  it.each(["single", "batched"] as const)(
    "does not adopt an unmarked legacy node during a %s reset",
    async (writer) => {
      const key = `agent:main:unmarked-${++nextId}`;
      write(key, { sessionId: `legacy-${nextId}`, updatedAt: 1 });
      const next = await reset(writer, key, {
        sessionId: `reset-${nextId}`,
        updatedAt: 2,
        conversationTopology: { version: 1, role: "root" },
      });
      expect(next.conversationTopology).toBeUndefined();
      expect(read(key)?.entry.conversationTopology).toBeUndefined();
    },
  );

  it("does not create a new logical node with a reset-builder's copied role", async () => {
    const key = `agent:main:unrelated-reset-create-${++nextId}`;
    const next = await reset("single", key, {
      sessionId: `unrelated-${nextId}`,
      updatedAt: 2,
      conversationTopology: { version: 1, role: "root" },
    });
    expect(next.conversationTopology).toBeUndefined();
    expect(read(key)?.entry.conversationTopology).toBeUndefined();
  });

  it("does not retarget an existing branch when its root incarnation changes", async () => {
    const original = binding();
    const branchKey = `agent:main:root-bound-branch-${++nextId}`;
    write("agent:main:main", {
      sessionId: "root-original",
      lifecycleRevision: "root-lifecycle-original",
      updatedAt: 1,
      conversationTopology: { version: 1, role: "root" },
    });
    write(branchKey, {
      sessionId: `branch-${nextId}`,
      updatedAt: 1,
      conversationTopology: original,
    });
    await resetSessionEntryLifecycle({
      agentId: "main",
      storePath: database.path,
      target: { canonicalKey: "agent:main:main", storeKeys: ["agent:main:main"] },
      buildNextEntry: () => ({
        sessionId: "root-replacement",
        lifecycleRevision: "root-lifecycle-replacement",
        updatedAt: 2,
      }),
    });
    expect(read("agent:main:main")?.entry.conversationTopology).toEqual({
      version: 1,
      role: "root",
    });
    expect(read(branchKey)?.entry.conversationTopology).toEqual(original);
  });
});
