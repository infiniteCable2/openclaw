import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withRegisteredChannelIngress } from "../../plugin-sdk/test-helpers/registered-channel-ingress.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { ChannelPlugin } from "../plugins/types.plugin.js";
import { defineStableChannelIngressIdentity } from "./runtime-identity.js";

const mocks = vi.hoisted(() => ({
  ensureSession: vi.fn(),
  openRecipient: vi.fn(),
  openRoot: vi.fn(),
}));
// mock-isolation: Exercise the real registered ingress proof; stop at native session materialization.
vi.mock("../../talk/client-voice-session-initialization.js", () => ({
  ensureClientVoiceAgentSessionEntry: mocks.ensureSession,
}));
// mock-isolation: Recipient scheduling has its own owner tests and must not start storage workers here.
vi.mock("../../auto-reply/reply/conversation-knowledge-open.js", () => ({
  openConversationKnowledgeRecipient: mocks.openRecipient,
  openConversationKnowledgeRoot: mocks.openRoot,
}));

const plugin: ChannelPlugin = {
  id: "example",
  meta: {
    id: "example",
    label: "Example",
    selectionLabel: "Example",
    docsPath: "/channels/example",
    blurb: "Connection fixture",
  },
  capabilities: { chatTypes: ["direct"] },
  config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
};
const scope = {
  channelId: "example",
  accountId: "default",
  rawPrincipalRef: "person-alpha",
  conversation: { kind: "direct" as const, id: "room-alpha" },
  binding: {
    agentId: "researcher",
    sessionKey: "agent:researcher:example:call-alpha",
    nativeChannelId: "room-alpha",
    inboundEventKind: "user_request" as const,
  },
};

type RootState = "registered" | "prepared" | "unavailable" | "invalidated";

async function fixture(
  run: (f: {
    open: (privateRoom?: boolean) => Promise<void>;
    prepareRoot: (options?: {
      privateRoom?: boolean;
      eventKind?: "conversation" | "message";
      inboundEventKind?: "room_event" | "user_request";
      onState?: (state: RootState) => void;
    }) => Promise<void>;
    abort: () => void;
    cleanup: () => Promise<void>;
    cleanupCount: () => number;
    revoke: () => void;
    retire: () => void;
    config: OpenClawConfig;
  }) => Promise<void>,
) {
  const config: OpenClawConfig = {
    agents: { entries: { researcher: { conversationMode: "branches" } } },
  };
  let live = true;
  const abort = new AbortController();
  const cleanups = new Set<() => Promise<void>>();
  const assertCurrent = () => {
    if (!live) {
      throw new Error("Connection closed");
    }
  };
  await withRegisteredChannelIngress(
    { plugin, config, setRuntime() {} },
    async (runtime, retire) => {
      const ingress = runtime.channel.inbound.ingress;
      const prepare = ingress.conversation?.prepareConnection;
      if (!prepare) {
        throw new Error("Registered ingress must support connection preparation");
      }
      const open = async (
        privateRoom = true,
        root?: {
          eventKind?: "conversation" | "message";
          inboundEventKind?: "room_event" | "user_request";
          onState?: (state: RootState) => void;
        },
      ) => {
        const selectedScope = root
          ? {
              ...scope,
              binding: {
                ...scope.binding,
                inboundEventKind: root.inboundEventKind ?? "room_event",
              },
            }
          : scope;
        const admitted = await ingress.resolve({
          channelId: scope.channelId,
          accountId: scope.accountId,
          identity: defineStableChannelIngressIdentity({
            authentication: "verified",
            resolveParticipant: () => ({
              domain: "example.test",
              idKind: "user-id",
              id: "person-alpha",
            }),
          }),
          subject: { stableId: scope.rawPrincipalRef },
          conversation: scope.conversation,
          contextBinding: selectedScope.binding,
          privateAudience: privateRoom ? { assertCurrent } : undefined,
          event: { kind: root?.eventKind ?? "conversation", authMode: "inbound", mayPair: false },
          policy: { dmPolicy: "allowlist", groupPolicy: "disabled" },
          allowFrom: [scope.rawPrincipalRef],
          readStoreAllowFrom: async () => [],
        });
        await prepare({
          ingress: admitted,
          scope: selectedScope,
          assertCurrent,
          ...(root
            ? {
                purpose: "root-preparation" as const,
                signal: abort.signal,
                onRootPreparationState: root.onState,
                retainCleanup: (close: () => Promise<void>) => {
                  cleanups.add(close);
                  return () => void cleanups.delete(close);
                },
              }
            : {}),
        });
      };
      await run({
        config,
        retire,
        revoke: () => {
          live = false;
        },
        open,
        prepareRoot: (options = {}) => open(options.privateRoom ?? true, options),
        abort: () => abort.abort(),
        cleanup: async () => {
          for (const close of cleanups) {
            await close();
          }
        },
        cleanupCount: () => cleanups.size,
      });
    },
  );
}

describe("registered channel connection preparation", () => {
  beforeEach(() => {
    mocks.ensureSession.mockReset().mockResolvedValue("session-alpha");
    mocks.openRecipient.mockReset().mockResolvedValue(undefined);
    mocks.openRoot.mockReset().mockResolvedValue(undefined);
  });

  it("initializes and opens the exact private recipient before any input exists", async () => {
    await fixture(async ({ open, revoke }) => {
      await open();
      expect(mocks.ensureSession).toHaveBeenCalledOnce();
      expect(mocks.openRecipient).toHaveBeenCalledOnce();
      const initialization = mocks.ensureSession.mock.calls[0]![0];
      const registration = mocks.openRecipient.mock.calls[0]![0];
      expect(initialization).toMatchObject({
        agentId: "researcher",
        sessionKey: scope.binding.sessionKey,
      });
      expect(registration.target).toMatchObject({
        agentId: scope.binding.agentId,
        sessionKey: scope.binding.sessionKey,
        sessionId: "session-alpha",
      });
      expect(registration.participant).toMatchObject({ type: "remote", id: "person-alpha" });
      expect(initialization).not.toHaveProperty("input");
      expect(registration).not.toHaveProperty("context");
      expect(initialization.privateAudience).toBe(registration.audience);
      expect(mocks.ensureSession.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.openRecipient.mock.invocationCallOrder[0]!,
      );
      revoke();
      expect(() => registration.audience.assertCurrent()).toThrow("Connection closed");
    });
  });

  it("does not create a recipient or session for a shared endpoint", async () => {
    await fixture(async ({ open }) => {
      await open(false);
    });
    expect(mocks.ensureSession).not.toHaveBeenCalled();
    expect(mocks.openRecipient).not.toHaveBeenCalled();
  });

  it("warms only an existing root from the native conversation handoff and joins its account cleanup", async () => {
    const close = vi.fn(async () => {});
    mocks.openRoot.mockResolvedValue({ close });
    await fixture(async ({ prepareRoot, abort, cleanup, cleanupCount }) => {
      await prepareRoot();
      expect(mocks.openRoot).toHaveBeenCalledOnce();
      expect(mocks.ensureSession).not.toHaveBeenCalled();
      expect(mocks.openRecipient).not.toHaveBeenCalled();
      const opening = mocks.openRoot.mock.calls[0]![0];
      expect(opening.target).toEqual({
        agentId: scope.binding.agentId,
        sessionKey: scope.binding.sessionKey,
        storePath: expect.any(String),
      });
      expect(opening.target).not.toHaveProperty("sessionId");
      expect(opening).not.toHaveProperty("input");
      expect(cleanupCount()).toBe(1);
      abort();
      await cleanup();
      expect(close).toHaveBeenCalled();
      expect(cleanupCount()).toBe(0);
      expect(() => opening.audience.assertCurrent()).toThrow();
    });
  });

  it("reports prepared only after a current complete native frame can be borrowed", async () => {
    let ready = false;
    let finished = () => {};
    const prepared = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const release = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const acquireInitialFrame = vi.fn(() => (ready ? { release } : undefined));
    mocks.openRoot.mockResolvedValue({ close, acquireInitialFrame });
    await fixture(async ({ prepareRoot, abort, cleanup }) => {
      const states: RootState[] = [];
      await prepareRoot({
        onState(state) {
          states.push(state);
          if (state === "prepared") {
            finished();
          }
        },
      });
      const native = mocks.openRoot.mock.calls[0]![0];
      native.onReady();
      expect(states).toEqual(["registered"]);
      ready = true;
      native.onReady();
      await prepared;
      native.onReady();
      expect(states).toEqual(["registered", "prepared"]);
      expect(release).toHaveBeenCalledOnce();
      abort();
      await cleanup();
    });
  });

  it("retains an unavailable enrollment and requalifies only on an actual native row change", async () => {
    let finish = () => {};
    const invalidated = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await fixture(async ({ prepareRoot, abort, cleanup, cleanupCount }) => {
      const states: RootState[] = [];
      await prepareRoot({
        onState(state) {
          states.push(state);
          if (state === "invalidated") {
            finish();
          }
        },
      });
      expect(states).toEqual(["unavailable"]);
      expect(cleanupCount()).toBe(1);
      const target = mocks.openRoot.mock.calls[0]![0].target;
      sessionChanges.emit({
        ...target,
        scope: "session-entry",
        facts: {
          kind: "entry",
          sessionId: "new-session",
          previousSessionId: undefined,
          category: null,
          clearMembers: false,
          lifecycleChanged: true,
        },
      });
      await invalidated;
      expect(cleanupCount()).toBe(0);
      const close = vi.fn(async () => {});
      mocks.openRoot.mockResolvedValue({ close });
      await prepareRoot();
      expect(mocks.openRoot).toHaveBeenCalledTimes(2);
      expect(mocks.ensureSession).not.toHaveBeenCalled();
      abort();
      await cleanup();
    });
  });

  it("ignores turn metadata and requalifies a hot config publication after successful retirement", async () => {
    let finish = () => {};
    const invalidated = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const close = vi.fn(async () => {});
    mocks.openRoot.mockResolvedValue({ close });
    await fixture(async ({ prepareRoot, abort, cleanup }) => {
      const states: RootState[] = [];
      await prepareRoot({
        onState(state) {
          states.push(state);
          if (state === "invalidated") {
            finish();
          }
        },
      });
      const target = mocks.openRoot.mock.calls[0]![0].target;
      sessionChanges.emit({ ...target, scope: "runtime" });
      sessionChanges.emit({ ...target, scope: "transcript", factsInvalidated: true });
      // A failed read may fence facts without a committed row publication.
      // It must not repeatedly wake its own requalification attempt.
      sessionChanges.invalidate({ ...target, factsInvalidated: true });
      sessionChanges.emit({ ...target, scope: "session-entry", factsInvalidated: "category" });
      sessionChanges.emit({
        ...target,
        scope: "session-entry",
        facts: {
          kind: "entry",
          previousSessionId: "same",
          sessionId: "same",
          category: "changed",
          clearMembers: false,
          lifecycleChanged: false,
        },
      });
      expect(close).not.toHaveBeenCalled();
      expect(states).toEqual(["registered"]);
      sessionChanges.emit({ all: true, scope: "config" });
      await invalidated;
      expect(close).toHaveBeenCalledOnce();
      expect(states).toEqual(["registered", "invalidated"]);
      abort();
      await cleanup();
    });
  });

  it("keeps failed cleanup retryable without announcing a successful requalification", async () => {
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("cleanup unavailable"))
      .mockResolvedValue(undefined);
    mocks.openRoot.mockResolvedValue({ close });
    await fixture(async ({ prepareRoot, abort, cleanup, cleanupCount }) => {
      const states: RootState[] = [];
      await prepareRoot({
        onState: (state) => {
          states.push(state);
        },
      });
      sessionChanges.emit({ all: true, scope: "config" });
      await expect(close.mock.results[0]!.value).rejects.toThrow("cleanup unavailable");
      expect(cleanupCount()).toBe(1);
      await cleanup();
      expect(states).toEqual(["registered"]);
      expect(cleanupCount()).toBe(0);
      abort();
    });
  });

  it("joins pending enrollment before announcing invalidation and never publishes a stale registration", async () => {
    let start = () => {};
    let finish = (_value: { close: () => Promise<void> }) => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const opening = new Promise<{ close: () => Promise<void> }>((resolve) => {
      finish = resolve;
    });
    mocks.openRoot.mockImplementation(() => {
      start();
      return opening;
    });
    let finishInvalidation = () => {};
    const invalidated = new Promise<void>((resolve) => {
      finishInvalidation = resolve;
    });
    await fixture(async ({ prepareRoot, abort, cleanup }) => {
      const states: RootState[] = [];
      const prepared = prepareRoot({
        onState(state) {
          states.push(state);
          if (state === "invalidated") {
            finishInvalidation();
          }
        },
      });
      await started;
      sessionChanges.emit({ all: true, scope: "config" });
      expect(states).toEqual([]);
      const close = vi.fn(async () => {});
      finish({ close });
      await prepared;
      await invalidated;
      expect(close).toHaveBeenCalled();
      expect(states).toEqual(["invalidated"]);
      abort();
      await cleanup();
    });
  });

  it.each([{ eventKind: "message" as const }, { inboundEventKind: "user_request" as const }])(
    "does not trust root purpose without the native endpoint classification: %s",
    async (options) => {
      await fixture(async ({ prepareRoot }) => {
        await expect(prepareRoot(options)).rejects.toThrow();
      });
      expect(mocks.openRoot).not.toHaveBeenCalled();
      expect(mocks.ensureSession).not.toHaveBeenCalled();
    },
  );

  it("does not warm a shared endpoint or retain a root revoked during native admission", async () => {
    const close = vi.fn(async () => {});
    await fixture(async ({ prepareRoot, revoke }) => {
      await prepareRoot({ privateRoom: false });
      expect(mocks.openRoot).not.toHaveBeenCalled();
      mocks.openRoot.mockImplementation(async () => {
        revoke();
        return { close };
      });
      await expect(prepareRoot()).rejects.toThrow("Connection closed");
      expect(close).toHaveBeenCalledOnce();
    });
    expect(mocks.ensureSession).not.toHaveBeenCalled();
  });

  it("refuses an endpoint revoked while initialization is pending", async () => {
    await fixture(async ({ open, revoke }) => {
      mocks.ensureSession.mockImplementation(async ({ assertCommitAllowed }) => {
        revoke();
        assertCommitAllowed();
        return "session-alpha";
      });
      await expect(open()).rejects.toThrow("Connection closed");
    });
    expect(mocks.openRecipient).not.toHaveBeenCalled();
  });

  it("retains registry and configuration fences in the background audience", async () => {
    await fixture(async ({ open, retire, config }) => {
      await open();
      expect(mocks.openRecipient).toHaveBeenCalledOnce();
      const audience = mocks.openRecipient.mock.calls[0]![0].audience;
      config.agents = { entries: { researcher: { conversationMode: "native" } } };
      expect(() => audience.assertCurrent()).toThrow();
      config.agents = { entries: { researcher: { conversationMode: "branches" } } };
      retire();
      expect(() => audience.assertCurrent()).toThrow();
    });
  });
});
