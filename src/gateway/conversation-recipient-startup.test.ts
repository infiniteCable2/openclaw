import { beforeEach, expect, it, vi } from "vitest";
import type { ConversationRecipientEnrollment } from "../config/sessions/conversation-recipient-enrollment.js";
import { projectSessionSharingEntry } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { ConversationPrivateAudience } from "../sessions/conversation-private-audience.js";
import { startGatewayConversationRecipients } from "./conversation-recipient-startup.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  custody: vi.fn(),
  projection: vi.fn(),
  foreground: vi.fn(),
}));
// mock-isolation: This scheduler test owns signals; native authority and SQLite have separate proofs.
vi.mock("../auto-reply/reply/conversation-knowledge-open.js", () => ({
  openConversationKnowledgeRoot: mocks.open,
}));
// mock-isolation: Observe original-principal reuse without booting identity storage for each scheduler case.
vi.mock("./operator-source-custody.js", () => ({
  prepareGatewayOperatorSourceCustody: mocks.custody,
}));
// mock-isolation: Feed native projection publications deterministically, without a second Gateway.
vi.mock("./session-row-projection-access.js", () => ({
  getSessionRowProjection: mocks.projection,
}));
// mock-isolation: Foreground reservations are explicit test events rather than real input turns.
vi.mock("../agents/session-maintenance/coordinator.js", () => ({
  onForegroundSessionMaintenanceChange: mocks.foreground,
}));
// mock-isolation: Exercise the coalescing owner without process-global command queue admission.
vi.mock("../process/background-work.js", () => ({
  createBackgroundWorkOwner: () => ({
    enqueue: (run: (signal: AbortSignal) => Promise<void>, options: { abortSignal: AbortSignal }) =>
      Promise.resolve().then(() => run(options.abortSignal)),
  }),
}));

function row(name: string, enrolled = true) {
  const branch = {
    agentId: "main",
    sessionKey: `agent:main:${name}`,
    sessionId: name,
    lifecycleRevision: "generation-1",
    storePath: "/synthetic/agent.sqlite",
    root: { sessionKey: "agent:main:root", sessionId: "root", lifecycleRevision: "root-1" },
  };
  const enrollment: ConversationRecipientEnrollment = {
    version: 1,
    lifetime: "reusable",
    branch,
    source: {
      kind: "operator",
      snapshot: {
        profileId: "person",
        scopes: ["operator.read", "operator.write"],
        assignedRole: null,
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "grant-1",
          role: "operator",
          authMethod: "trusted-proxy",
        },
        controlUiAdmin: false,
        localOperator: false,
        sourceIngress: "internal",
      },
    },
  };
  const entry: InternalSessionEntry = {
    sessionId: name,
    updatedAt: 1,
    lifecycleRevision: branch.lifecycleRevision,
    visibility: "draft",
    chatType: "direct",
    conversationTopology: {
      version: 1,
      role: "branch",
      rootSessionKey: branch.root.sessionKey,
      rootSessionId: branch.root.sessionId,
      rootSessionLifecycleRevision: branch.root.lifecycleRevision,
    },
    ...(enrolled ? { conversationRecipientEnrollment: enrollment } : {}),
  };
  return {
    agentId: branch.agentId,
    key: branch.sessionKey,
    storeTarget: { storePath: branch.storePath },
    entry,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockImplementation(async () => ({ close: vi.fn(async () => {}) }));
  mocks.custody.mockImplementation(async ({ assertCurrent }: { assertCurrent: () => void }) => ({
    profileId: "person",
    assertCurrent,
    signal: new AbortController().signal,
    retain: () => vi.fn(),
    release: vi.fn(),
  }));
});

function start(rows: ReturnType<typeof row>[], initiallyBusy = false) {
  let onFacts: (change: { kind: "row"; key: string } | { kind: "reset" }) => void = () => {};
  let onForeground: (active: boolean) => void = () => {};
  mocks.foreground.mockImplementation((listener: typeof onForeground) => {
    onForeground = listener;
    listener(initiallyBusy);
    return vi.fn();
  });
  mocks.projection.mockReturnValue({
    ensureMaterialized: async () => {},
    selectEntries: (query?: { key: string }) =>
      rows.filter((value) => !query || query.key === value.key),
    sharingTarget: ({ key }: { key: string }) => {
      const selected = rows.find((value) => value.key === key);
      return selected && { ...selected, entry: projectSessionSharingEntry(selected.entry) };
    },
    onFactsChange: (listener: typeof onFacts) => {
      onFacts = listener;
    },
  });
  const context = createContext();
  const cfg = { agents: { entries: { main: { conversationMode: "branches" as const } } } };
  context.getRuntimeConfig = () => cfg;
  context.getCommittedRuntimeConfig = () => cfg;
  const signal = new AbortController();
  const log = { warn: vi.fn() };
  const owner = startGatewayConversationRecipients({ context, signal: signal.signal, log })!;
  return {
    ...owner,
    log,
    change: (key: string) => onFacts({ kind: "row", key }),
    foreground: (active: boolean) => onForeground(active),
  };
}

it("restores independent reusable paths without connections or turns; excludes old calls and private mismatches", async () => {
  const rows = [
    row("device-a"),
    row("device-b"),
    row("device-c"),
    row("chat"),
    row("closed-call", false),
    row("archived"),
    row("shared"),
    row("replaced"),
  ];
  rows[5]!.entry.archivedAt = 1;
  rows[6]!.entry.publicShare = { id: "share", sessionId: "shared", createdAt: 1 };
  rows[7]!.entry.lifecycleRevision = "generation-2";
  const owner = start(rows);
  try {
    await owner.settled();
    expect(mocks.open).toHaveBeenCalledTimes(4);
    for (const item of rows) {
      owner.change(item.key);
    }
    await owner.settled();
    expect(mocks.open).toHaveBeenCalledTimes(4);
  } finally {
    await owner.close();
  }
});

it.each(["shared", "group"] as const)(
  "waits for foreground release and retires a %s recipient without reopening it",
  async (change) => {
    const target = row("device");
    const owner = start([target], true);
    try {
      await owner.settled();
      expect(mocks.open).not.toHaveBeenCalled();
      owner.foreground(false);
      await owner.settled();
      expect(mocks.open).toHaveBeenCalledOnce();
      const audience = mocks.open.mock.calls[0]![0].audience as ConversationPrivateAudience;
      if (change === "shared") {
        target.entry.publicShare = { id: "share", sessionId: "device", createdAt: 2 };
      } else {
        target.entry.chatType = "group";
      }
      expect(() => audience.assertCurrent()).toThrow();
      owner.change(target.key);
      await owner.settled();
      expect(mocks.open).toHaveBeenCalledOnce();
    } finally {
      await owner.close();
    }
  },
);

it("does not retry a revoked original source on unrelated transcript publications", async () => {
  mocks.custody.mockRejectedValue(new Error("original grant revoked"));
  const target = row("device");
  const owner = start([target]);
  try {
    await owner.settled();
    for (let update = 0; update < 5; update++) {
      owner.change(target.key);
      await owner.settled();
    }
    expect(mocks.custody).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(owner.log.warn).toHaveBeenCalledOnce();
  } finally {
    await owner.close();
  }
});

it("rearms unavailable native facts only after a later publication", async () => {
  mocks.custody.mockRejectedValueOnce(new SessionMutationFactsUnavailableError());
  const target = row("device");
  const owner = start([target]);
  try {
    await owner.settled();
    expect(mocks.custody).toHaveBeenCalledOnce();
    owner.change(target.key);
    await owner.settled();
    expect(mocks.custody).toHaveBeenCalledTimes(2);
    expect(mocks.open).toHaveBeenCalledOnce();
  } finally {
    await owner.close();
  }
});

it("joins every recipient cleanup and retains a failed close for retry", async () => {
  const first = vi.fn(async () => {}).mockRejectedValueOnce(new Error("cleanup deferred"));
  const second = vi.fn(async () => {});
  mocks.open.mockResolvedValueOnce({ close: first }).mockResolvedValueOnce({ close: second });
  const owner = start([row("first"), row("second")]);
  await owner.settled();
  await expect(owner.close()).rejects.toThrow("cleanup remains pending");
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  await owner.close();
  expect(first).toHaveBeenCalledTimes(2);
  expect(second).toHaveBeenCalledOnce();
});

it("retains cleanup when privacy changes after opening and the first close fails", async () => {
  const target = row("device");
  const close = vi.fn(async () => {}).mockRejectedValueOnce(new Error("cleanup deferred"));
  mocks.open.mockImplementationOnce(async () => {
    target.entry.chatType = "group";
    return { close };
  });
  const owner = start([target]);
  await owner.settled();
  expect(close).toHaveBeenCalledOnce();
  const custody = await mocks.custody.mock.results[0]!.value;
  expect(custody.release).not.toHaveBeenCalled();
  await owner.close();
  expect(close).toHaveBeenCalledTimes(2);
  expect(custody.release).toHaveBeenCalledOnce();
  expect(mocks.open).toHaveBeenCalledOnce();
});
