import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import * as lifecycle from "./session-accessor.sqlite-projection.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { enrollSessionConversationBranch } from "./session-conversation-enrollment.js";
import { resolveAgentConversationRootSessionKey } from "./session-conversation-root-key.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";
import type { InternalSessionEntry } from "./types.js";

let state: OpenClawTestState;
let storePath: string;
let nextId = 0;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "conversation-enrollment" });
  storePath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await state.cleanup();
});

async function fixture(patch: Partial<InternalSessionEntry> = {}) {
  const sessionKey = `agent:main:enrollment-${++nextId}`;
  let cfg: OpenClawConfig = {
    agents: { entries: { main: { conversationMode: "branches" } } },
    session: { store: storePath },
  };
  const rootSessionKey = resolveAgentConversationRootSessionKey({ cfg, agentId: "main" });
  const scope = { agentId: "main", env: state.env, storePath, sessionKey };
  const rootScope = { ...scope, sessionKey: rootSessionKey };
  const root: InternalSessionEntry = {
    sessionId: `root-${nextId}`,
    lifecycleRevision: `root-lifecycle-${nextId}`,
    updatedAt: 1,
    createdVia: "internal",
    createdActor: { type: "system", id: "conversation-root" },
    visibility: "draft",
    delivery: { kind: "none" },
    conversationTopology: { version: 1, role: "root" },
  };
  replaceSessionEntrySync(rootScope, root);
  replaceSessionEntrySync(scope, {
    sessionId: `conversation-${nextId}`,
    lifecycleRevision: `conversation-lifecycle-${nextId}`,
    createdAt: 2,
    updatedAt: 3,
    chatType: "direct",
    visibility: "draft",
    createdVia: "channel",
    createdActor: { type: "human", source: "profile", id: "synthetic-person" },
    owner: { actor: { type: "human", id: "synthetic-person" }, assignedAt: 2 },
    skillsSnapshot: { prompt: "Retain the original saved prompt.", skills: [] },
    delivery: normalizeSessionDeliveryState({
      context: { channel: "matrix", to: "synthetic-room" },
    }),
    ...patch,
  });
  const created = await readSessionEntryReadOnlyInWorker(scope);
  if (!created) {
    throw new Error("Expected the real original enrollment row");
  }
  await appendTranscriptMessage(
    { ...scope, sessionId: created.sessionId },
    {
      message: { role: "user", content: "Retain this original conversation." },
    },
  );
  const before = await readSessionEntryReadOnlyInWorker(scope);
  if (!before) {
    throw new Error("Expected the original row after its native transcript append");
  }
  const events = await loadTranscriptEvents({ ...scope, sessionId: before.sessionId });
  let current = true;
  const params = {
    ...scope,
    cfg,
    getConfig: () => cfg,
    assertCurrent: () => {
      if (!current) {
        throw new Error("Original enrollment caller revoked");
      }
    },
  };
  return {
    scope,
    rootScope,
    root,
    before,
    events,
    params,
    revoke: () => {
      current = false;
    },
    setMode: (mode: "native" | "branches") => {
      cfg = { ...cfg, agents: { entries: { main: { conversationMode: mode } } } };
    },
    read: () => readSessionEntryReadOnlyInWorker(scope),
    history: () => loadTranscriptEvents({ ...scope, sessionId: before.sessionId }),
  };
}

it.each(["direct", "group", "channel"] as const)(
  "enrolls an exact existing %s conversation without changing content or authority",
  async (chatType) => {
    const f = await fixture({ chatType });
    const rootBefore = await readSessionEntryReadOnlyInWorker(f.rootScope);
    const result = await enrollSessionConversationBranch(f.params);
    const saved = await f.read();
    expect(result.enrolled).toBe(true);
    expect(saved).toEqual({
      ...f.before,
      conversationTopology: {
        version: 1,
        role: "branch",
        rootSessionKey: f.rootScope.sessionKey,
        rootSessionId: f.root.sessionId,
        rootSessionLifecycleRevision: f.root.lifecycleRevision,
      },
    });
    expect(await f.history()).toEqual(f.events);
    expect(await readSessionEntryReadOnlyInWorker(f.rootScope)).toEqual(rootBefore);
    const mutation = vi.spyOn(lifecycle, "applySessionEntryLifecycleMutation");
    await expect(enrollSessionConversationBranch(f.params)).resolves.toEqual({
      entry: saved,
      enrolled: false,
    });
    expect(mutation).not.toHaveBeenCalled();
  },
);

it("allows an explicit native-mode enrollment without activating branch routing", async () => {
  const f = await fixture();
  f.setMode("native");
  await expect(enrollSessionConversationBranch(f.params)).rejects.toThrow("configuration changed");
  expect(await f.read()).toEqual(f.before);
  await expect(
    enrollSessionConversationBranch({ ...f.params, expectedMode: "native" }),
  ).resolves.toMatchObject({ enrolled: true });
  expect(await f.history()).toEqual(f.events);
});

it.each([
  { parentSessionKey: "agent:main:original" },
  { spawnedBy: "agent:main:original" },
  { forkSource: { sessionKey: "agent:main:original", sessionId: "original" } },
  { incognito: true },
  { archivedAt: 1 },
  { heartbeatIsolatedBaseSessionKey: "agent:main:original" },
] satisfies Partial<InternalSessionEntry>[])(
  "refuses non-conversation metadata %# without changing it",
  async (patch) => {
    const f = await fixture(patch);
    await expect(enrollSessionConversationBranch(f.params)).rejects.toThrow(
      "existing live, non-task",
    );
    expect(await f.read()).toEqual(f.before);
    expect(await f.history()).toEqual(f.events);
  },
);

it.each(["agent:main:subagent:task", "agent:main:cron:job", "agent:other:conversation"])(
  "never targets a task or foreign session %s",
  async (sessionKey) => {
    const f = await fixture();
    await expect(enrollSessionConversationBranch({ ...f.params, sessionKey })).rejects.toThrow(
      "same-agent, non-task",
    );
    expect(await f.read()).toEqual(f.before);
  },
);

it.each(["reset", "source", "root", "mode", "abort"] as const)(
  "refuses %s changes across the native lifecycle await without enrollment",
  async (change) => {
    const f = await fixture();
    const signal = new AbortController();
    let expected = f.before;
    const mutate = lifecycle.applySessionEntryLifecycleMutation;
    vi.spyOn(lifecycle, "applySessionEntryLifecycleMutation").mockImplementationOnce(
      async (input) => {
        if (change === "reset") {
          replaceSessionEntrySync(f.scope, {
            ...f.before,
            sessionId: "concurrent-reset",
            lifecycleRevision: "replacement",
          });
          const winner = await f.read();
          if (!winner) {
            throw new Error("Expected the actual concurrent reset winner");
          }
          expected = winner;
        } else if (change === "root") {
          replaceSessionEntrySync(f.rootScope, {
            ...f.root,
            sessionId: "replacement-root",
            lifecycleRevision: "replacement",
          });
        } else if (change === "source") {
          f.revoke();
        } else if (change === "mode") {
          f.setMode("native");
        } else {
          signal.abort(new Error("Enrollment cancelled"));
        }
        return mutate(input);
      },
    );
    await expect(
      enrollSessionConversationBranch({ ...f.params, signal: signal.signal }),
    ).rejects.toThrow();
    expect(await f.read()).toEqual(expected);
    expect(await f.history()).toEqual(f.events);
  },
);

it("rolls back when the actual caller revokes at the native COMMIT grant", async () => {
  const f = await fixture();
  let lifecycleValidated = false;
  const revoked = vi.fn(f.revoke);
  sqliteWorkerOwnerProbe.admission(admission, (request, grant, callback) => {
    if (
      request.stage === "transaction" &&
      isRecord(request.facts) &&
      request.facts.kind === "session-lifecycle-source-validated"
    ) {
      lifecycleValidated = true;
    }
    if (lifecycleValidated && request.stage === "commit") {
      revoked();
    }
    callback(request, grant);
  });
  await expect(enrollSessionConversationBranch(f.params)).rejects.toThrow(
    "Original enrollment caller revoked",
  );
  expect(revoked).toHaveBeenCalledOnce();
  expect(await f.read()).toEqual(f.before);
  expect(await f.history()).toEqual(f.events);
});

it("never creates a missing root or adopts a different existing root binding", async () => {
  const f = await fixture();
  await lifecycle.applySessionEntryLifecycleMutation({
    ...f.scope,
    skipMaintenance: true,
    removals: [{ sessionKey: f.rootScope.sessionKey }],
  });
  await expect(enrollSessionConversationBranch(f.params)).rejects.toThrow("root is not admitted");
  expect(await readSessionEntryReadOnlyInWorker(f.rootScope)).toBeUndefined();
  expect(await f.read()).toEqual(f.before);
  replaceSessionEntrySync(f.rootScope, f.root);
  replaceSessionEntrySync(f.scope, {
    ...f.before,
    conversationTopology: {
      version: 1,
      role: "branch",
      rootSessionKey: f.rootScope.sessionKey,
      rootSessionId: "previous-root",
      rootSessionLifecycleRevision: "previous",
    },
  });
  const existing = await f.read();
  await expect(enrollSessionConversationBranch(f.params)).rejects.toThrow("cannot rebind");
  expect(await f.read()).toEqual(existing);
  expect(await f.history()).toEqual(f.events);
});
