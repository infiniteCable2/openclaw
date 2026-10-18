import { expect, it } from "vitest";
import {
  recordCommittedSessionMetadataPublication,
  retainPreparedSessionEntryPredicate,
  retainPreparedSessionGenerationFacts,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import {
  projectSessionSharingEntry,
  sessionSharingEntriesEqual,
} from "./session-accessor.sqlite-entry-cache.types.js";
import { assertSessionConversationRootEntry } from "./session-conversation-admission.js";
import type { SessionConversationTopology } from "./session-conversation-topology.js";
import { projectPublicSessionEntry } from "./session-entry-projection.js";
import { resolveSessionWorkStartError } from "./session-work-start.js";
import type { InternalSessionEntry } from "./types.js";

const sessionId = "sharing-lifecycle";

it("retains root admission and lineage facts through native sharing projection", () => {
  const root: InternalSessionEntry = {
    sessionId,
    updatedAt: 1,
    lifecycleRevision: "root-generation",
    createdVia: "internal",
    createdActor: { type: "system", id: "conversation-root" },
    visibility: "draft",
    delivery: { kind: "none" },
    conversationTopology: { version: 1, role: "root" },
  };
  const retained = projectSessionSharingEntry(root);
  expect(() => assertSessionConversationRootEntry(retained, "agent:example:main")).not.toThrow();
  expect(retained.delivery).not.toBe(root.delivery);
  for (const changes of [
    { parentSessionId: "parent-original" },
    { parentSessionLifecycleRevision: "parent-generation" },
    { spawnedBySessionId: "spawner-original" },
    { forkSource: { sessionKey: "agent:example:source", sessionId: "source-original" } },
    { forkedFromParent: true },
  ]) {
    const entry = { ...root, ...changes };
    expect(sessionSharingEntriesEqual(root, entry)).toBe(false);
    expect(() =>
      assertSessionConversationRootEntry(projectSessionSharingEntry(entry), "agent:example:main"),
    ).toThrow("not admitted");
  }
});
const tombstone = {
  cycleId: "recovery-cycle",
  revision: 1,
  chargedAttempts: 1,
  tombstone: { reason: "recovery exhausted" },
} satisfies NonNullable<InternalSessionEntry["mainRestartRecovery"]>;

const cases: Array<{
  name: string;
  changes: Partial<InternalSessionEntry>;
  message?: string;
}> = [
  { name: "allowed session", changes: {} },
  {
    name: "provider pause",
    changes: {
      providerReview: {
        id: "review-1",
        sessionId,
        runId: "refused-run",
        provider: "openai",
        model: "test-model",
        runtimeId: "codex",
      },
    },
    message: "paused as a precaution",
  },
  {
    name: "pending initialization",
    changes: { initializationPending: true },
    message: "still initializing",
  },
  {
    name: "incognito age despite recent activity",
    changes: { incognito: true, createdAt: 1 },
    message: "expired",
  },
  {
    name: "restart tombstone",
    changes: { mainRestartRecovery: tombstone },
    message: "Use /new or /reset",
  },
  {
    name: "restart tombstone with model lock",
    changes: { mainRestartRecovery: tombstone, modelSelectionLocked: true },
    message: "cannot be replaced while model selection is locked",
  },
  {
    name: "pending project",
    changes: { pendingProjectGitUrl: "https://github.com/example/project.git" },
    message: "workspace is not ready",
  },
  {
    name: "pending worktree",
    changes: { pendingWorktree: { titleSource: "New checkout" } },
    message: "workspace is not ready",
  },
];

it.each(cases)(
  "preserves $name work-start behavior in retained sharing facts",
  ({ changes, message }) => {
    const entry: InternalSessionEntry = { sessionId, updatedAt: Date.now(), ...changes };
    const key = entry.incognito ? "agent:main:dashboard:incognito-lifecycle" : "agent:main:main";
    const expected = resolveSessionWorkStartError(key, entry);
    if (message) {
      expect(expected).toContain(message);
    } else {
      expect(expected).toBeUndefined();
    }
    expect(resolveSessionWorkStartError(key, projectSessionSharingEntry(entry))).toBe(expected);
  },
);

it("retains independent nested lifecycle records after the source entry changes", () => {
  const providerReview = {
    id: "review-1",
    sessionId,
    runId: "refused-run",
    provider: "openai",
    model: "test-model",
    runtimeId: "codex",
    review: {
      explanation: "Inspect the selected operation.",
      continuation: { message: "Continue only within the selected project." },
      errorType: "misalignment_policy_violation",
    },
  } satisfies NonNullable<InternalSessionEntry["providerReview"]>;
  const mainRestartRecovery = structuredClone(tombstone);
  const pendingWorktree = {
    titleSource: "New checkout",
    source: { kind: "project", id: "original-project" },
  } satisfies NonNullable<InternalSessionEntry["pendingWorktree"]>;
  const entry: InternalSessionEntry = {
    sessionId,
    updatedAt: 1,
    providerReview,
    mainRestartRecovery,
    pendingWorktree,
  };
  const expected = structuredClone(entry);
  const retained = projectSessionSharingEntry(entry);

  providerReview.review.continuation.message = "Changed continuation";
  mainRestartRecovery.tombstone.reason = "Changed recovery";
  pendingWorktree.source.id = "replacement-project";

  expect(retained.providerReview).toEqual(expected.providerReview);
  expect(retained.mainRestartRecovery).toEqual(expected.mainRestartRecovery);
  expect(retained.pendingWorktree).toEqual(expected.pendingWorktree);
});

it.each<SessionConversationTopology>([
  { version: 1, role: "root" },
  {
    version: 1,
    role: "branch",
    rootSessionKey: "agent:example:main",
    rootSessionId: "root-original",
    rootSessionLifecycleRevision: "root-original-lifecycle",
  },
])("retains private $role topology for authorized admission without publishing it", (topology) => {
  const entry: InternalSessionEntry = {
    sessionId,
    updatedAt: 1,
    conversationTopology: topology,
  };
  const retained = projectSessionSharingEntry(entry);
  expect(retained.conversationTopology).toEqual(topology);
  expect(retained.conversationTopology).not.toBe(topology);
  expect(sessionSharingEntriesEqual(entry, { ...entry, updatedAt: 2 })).toBe(true);
  expect(sessionSharingEntriesEqual(entry, { sessionId, updatedAt: 1 })).toBe(false);
  expect(projectPublicSessionEntry(retained)).not.toHaveProperty("conversationTopology");
});

it("retains native audience facts independently and publishes changes to their held owners", () => {
  const entry: InternalSessionEntry = {
    sessionId,
    updatedAt: 1,
    chatType: "direct",
    participantCount: 1,
    publicShare: { id: "example-share", sessionId, createdAt: 1 },
    participants: [{ identity: { type: "profile", id: "example-person" } }],
  };
  const retained = projectSessionSharingEntry(entry);
  expect(retained.chatType).toBe("direct");
  expect(retained.participantCount).toBe(1);
  expect(retained.publicShare).toEqual(entry.publicShare);
  expect(retained.publicShare).not.toBe(entry.publicShare);
  expect(retained.participants).toEqual(entry.participants);
  expect(retained.participants).not.toBe(entry.participants);
  expect(sessionSharingEntriesEqual(entry, { ...entry, updatedAt: 2 })).toBe(true);
  for (const change of [
    { chatType: "channel" as const },
    { participantCount: 2 },
    { publicShare: undefined },
    { participants: undefined },
  ]) {
    expect(sessionSharingEntriesEqual(entry, { ...entry, ...change })).toBe(false);
  }
});

it("updates held audience counts through the native participant publication owner", () => {
  const key = "agent:example:audience-publication";
  const retained = retainPreparedSessionSharingFacts({
    databaseIdentity: "file:synthetic-audience-source",
    sessionKey: key,
    entry: projectSessionSharingEntry({
      sessionId,
      updatedAt: 1,
      chatType: "direct",
      participantCount: 1,
    }),
    membership: new Set(),
  });
  try {
    recordCommittedSessionMetadataPublication("synthetic-audience-source", key, {
      kind: "participants",
      projection: {
        participants: [
          { identity: { type: "agent", id: "example-a" } },
          { identity: { type: "agent", id: "example-b" } },
        ],
        participantCount: 2,
      },
    });
    expect(retained.readCurrent()?.entry?.participantCount).toBe(2);
    expect(retained.readCurrent()?.entry?.participants).toEqual([
      { identity: { type: "agent", id: "example-a" } },
      { identity: { type: "agent", id: "example-b" } },
    ]);
    expect(retained.readCurrent()?.entry?.sessionId).toBe(sessionId);
  } finally {
    retained.release();
  }
});

it("rejects an acquiring audience snapshot that crosses a participant publication", () => {
  const key = "agent:example:audience-acquisition";
  const retained = retainPreparedSessionSharingFacts({
    databaseIdentity: "file:synthetic-audience-acquisition-source",
    sessionKey: key,
    acquiring: true,
  });
  try {
    recordCommittedSessionMetadataPublication("synthetic-audience-acquisition-source", key, {
      kind: "participants",
      projection: {
        participants: [
          { identity: { type: "agent", id: "example-a" } },
          { identity: { type: "agent", id: "example-b" } },
        ],
        participantCount: 2,
      },
    });
    expect(() =>
      retained.initialize({
        entry: projectSessionSharingEntry({ sessionId, updatedAt: 1, participantCount: 1 }),
        membership: new Set(),
      }),
    ).toThrow("acquisition is no longer current");
  } finally {
    retained.release();
  }
});

it("invalidates an unknown participant postimage without replacing generation custody", () => {
  const databaseIdentity = "file:synthetic-unknown-audience-source";
  const key = "agent:example:unknown-audience";
  const entry = projectSessionSharingEntry({
    sessionId,
    lifecycleRevision: "original-generation",
    updatedAt: 1,
    chatType: "direct",
    participantCount: 1,
    participants: [{ identity: { type: "profile", id: "example-person" } }],
  });
  const retained = retainPreparedSessionSharingFacts({
    databaseIdentity,
    sessionKey: key,
    entry,
    membership: new Set(),
  });
  const generation = retainPreparedSessionGenerationFacts({
    databaseIdentity,
    sessionKey: key,
    entry,
  });
  const predicate = retainPreparedSessionEntryPredicate({
    databaseIdentity,
    sessionKey: key,
    entry,
    matches: (before, after) => before?.participantCount === after?.participantCount,
  });
  try {
    expect(predicate.isCurrent()).toBe(true);
    recordCommittedSessionMetadataPublication("synthetic-unknown-audience-source", key, {
      kind: "participants",
    });
    expect(retained.readCurrent()).toBeUndefined();
    expect(predicate.isCurrent()).toBe(false);
    expect(predicate.canRefresh()).toBe(true);
    expect(generation.readCurrent()).toMatchObject({
      sessionId,
      lifecycleRevision: "original-generation",
    });
  } finally {
    predicate.release();
    generation.release();
    retained.release();
  }
});
