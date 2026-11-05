import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { createDirectRoomTracker } from "./direct.js";
import {
  createMatrixStartupRootPreparation,
  prepareMatrixStartupConversationRoots,
} from "./startup-history.js";

const roomId = "!private:example.test";
const self = "@assistant:example.test";
const person = "@person:example.test";

function fixture() {
  const cfg = {
    channels: { matrix: { dm: { policy: "allowlist", allowFrom: [person] } } },
    agents: { entries: { main: { conversationMode: "branches" as const } } },
  } satisfies CoreConfig;
  const core = createPluginRuntimeMock();
  type Prepare = NonNullable<
    NonNullable<typeof core.channel.inbound.ingress.conversation>["prepareConnection"]
  >;
  const prepare = vi.fn<Prepare>(async () => {});
  const admit = vi.fn();
  Object.assign(core.channel.inbound.ingress, {
    conversation: { version: 1, prepareConnection: prepare, admitInput: admit },
  });
  setMatrixRuntime(core);
  const abort = new AbortController();
  const client = {
    getUserId: vi.fn(async () => self),
    getJoinedRooms: vi.fn(async () => [roomId, roomId, "!shared:example.test"]),
    getJoinedRoomMembers: vi.fn(async (id: string) =>
      id === roomId ? [self, person] : [self, person, "@guest:example.test"],
    ),
    doRequest: vi.fn(async () => [
      { type: "m.room.member", state_key: self, content: { membership: "join", is_direct: true } },
      { type: "m.room.member", state_key: person, content: { membership: "join" } },
      { type: "m.room.join_rules", state_key: "", content: { join_rule: "invite" } },
    ]),
    getRoomStateEvent: vi.fn(async () => ({ is_direct: true })),
    dms: { update: vi.fn(async () => true), isDm: vi.fn(() => true) },
  };
  // The tracker exercises actual native membership/privacy parsing; network and registrations are leaves.
  const nativeClient = client as unknown as MatrixClient;
  const tracker = createDirectRoomTracker(nativeClient, {
    isCurrent: () => !abort.signal.aborted,
    isAudienceCurrent: () => !abort.signal.aborted,
  });
  const params: Parameters<typeof prepareMatrixStartupConversationRoots>[0] = {
    client: nativeClient,
    core,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    accountId: "default",
    groupPolicy: "disabled",
    directTracker: tracker,
    startupAllowFrom: [],
    startupGroupAllowFrom: [],
    getRuntimeConfig: () => cfg,
    getRoomInfo: async () => ({ altAliases: [] }),
    signal: abort.signal,
    assertCurrent: () => abort.signal.throwIfAborted(),
    retainCleanup() {},
  };
  return { cfg, core, client, tracker, params, prepare, admit, abort };
}

function startupTaskFixture() {
  const f = fixture();
  f.client.getJoinedRooms.mockResolvedValue([roomId]);
  const firstRetry = Promise.withResolvers<void>();
  const tasks: Promise<void>[] = [];
  let configChanged = () => {};
  vi.mocked(f.core.config.subscribe).mockImplementation((listener) => {
    configChanged = listener;
    return () => {};
  });
  const log = vi.fn((...args: unknown[]) => {
    if (args[0] === "matrix: related-history startup qualification retry") {
      firstRetry.resolve();
    }
  });
  const preparation = createMatrixStartupRootPreparation({
    ...f.params,
    runtime: { ...f.params.runtime, log },
    runTask(task) {
      const pending = Promise.resolve().then(task);
      tasks.push(pending);
      return pending;
    },
  });
  return {
    ...f,
    preparation,
    tasks,
    log,
    firstRetry,
    configChanged: () => configChanged(),
    async close() {
      f.abort.abort();
      await Promise.allSettled(tasks);
      f.tracker.dispose();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("healthy Matrix startup root preparation", () => {
  it("retries a failed qualification through the account task while keeping successful scopes", async () => {
    vi.useFakeTimers();
    const f = startupTaskFixture();
    const otherRoom = "!other-private:example.test";
    f.client.getJoinedRooms.mockResolvedValue([roomId, otherRoom]);
    f.client.getJoinedRoomMembers.mockResolvedValue([self, person]);
    f.prepare.mockImplementation(async (input) => {
      input.onRootPreparationState?.("prepared");
    });
    f.prepare.mockRejectedValueOnce(new Error("private endpoint https://private.example.test"));
    try {
      f.preparation.request();
      await f.firstRetry.promise;
      expect(f.prepare).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(f.prepare).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await f.tasks[0];
      expect(f.prepare).toHaveBeenCalledTimes(3);
      expect(
        f.prepare.mock.calls.filter(([input]) => input.scope.binding.nativeChannelId === otherRoom),
      ).toHaveLength(1);
      expect(f.prepare.mock.calls[0]![0].signal?.aborted).toBe(true);
      expect(f.admit).not.toHaveBeenCalled();
      expect(f.core.channel.inbound.dispatch).not.toHaveBeenCalled();
      const diagnostics = JSON.stringify(f.log.mock.calls);
      expect(diagnostics).toContain('"phase":"registration"');
      expect(diagnostics).toContain('"failureClass":"unknown"');
      expect(diagnostics).not.toContain(roomId);
      expect(diagnostics).not.toContain(person);
      expect(diagnostics).not.toContain("https://");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });

  it("retries an account lookup failure before creating any room scope", async () => {
    vi.useFakeTimers();
    const f = startupTaskFixture();
    f.client.getJoinedRooms.mockRejectedValueOnce(new TypeError("private network details"));
    try {
      f.preparation.request();
      await f.firstRetry.promise;
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.log).toHaveBeenCalledWith("matrix: related-history startup qualification failed", {
        phase: "rooms",
        failureClass: "TypeError",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await f.tasks[0];
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });

  it("keeps an explicit admission refusal event-driven", async () => {
    vi.useFakeTimers();
    const f = startupTaskFixture();
    const error = new Error("private refusal details");
    error.name = "ConversationInputAdmissionError";
    f.prepare.mockRejectedValue(error);
    try {
      f.preparation.request();
      await f.tasks[0];
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(f.log).toHaveBeenCalledWith("matrix: related-history startup qualification failed", {
        phase: "registration",
        failureClass: "ConversationInputAdmissionError",
      });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });

  it("retries a failed membership read but leaves refused privacy evidence event-driven", async () => {
    vi.useFakeTimers();
    const f = startupTaskFixture();
    f.client.getJoinedRoomMembers.mockRejectedValueOnce(new Error("temporary lookup failure"));
    // An authoritative private-room refusal on the retry must not create another timer.
    f.client.doRequest.mockResolvedValue([]);
    try {
      f.preparation.request();
      await f.firstRetry.promise;
      expect(f.log).toHaveBeenCalledWith("matrix: related-history startup qualification failed", {
        phase: "membership",
        failureClass: "unavailable",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await f.tasks[0];
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.client.getJoinedRoomMembers).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });

  it("retries rejected private-room state reads without retrying an actual privacy refusal", async () => {
    vi.useFakeTimers();
    const f = startupTaskFixture();
    f.client.doRequest.mockRejectedValueOnce(new Error("private homeserver URL and details"));
    try {
      f.preparation.request();
      await f.firstRetry.promise;
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.log).toHaveBeenCalledWith("matrix: related-history startup qualification failed", {
        phase: "privacy",
        failureClass: "MatrixPrivateAudienceReadError",
      });
      expect(JSON.stringify(f.log.mock.calls)).not.toContain("homeserver URL");
      await vi.advanceTimersByTimeAsync(1_000);
      await f.tasks[0];
      expect(f.prepare).toHaveBeenCalledOnce();
      // A later real room event requalifies, but denied state itself starts no retry.
      f.client.doRequest.mockResolvedValue([]);
      f.preparation.request(roomId);
      await f.tasks[1];
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });

  it("bounds transient registration retries and rearms on the next native room event", async () => {
    vi.useFakeTimers();
    const f = startupTaskFixture();
    const error = new Error("private transient details");
    error.name = "SessionMutationFactsUnavailableError";
    f.prepare.mockRejectedValue(error);
    try {
      f.preparation.request();
      await f.firstRetry.promise;
      await vi.advanceTimersByTimeAsync(7_000);
      await f.tasks[0];
      expect(f.prepare).toHaveBeenCalledTimes(4);
      expect(f.log).toHaveBeenCalledWith("matrix: related-history startup qualification deferred");
      expect(vi.getTimerCount()).toBe(0);
      f.prepare.mockResolvedValue(undefined);
      f.preparation.request(roomId);
      await f.tasks[1];
      expect(f.prepare).toHaveBeenCalledTimes(5);
      expect(f.tasks).toHaveLength(2);
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });

  it.each(["abort", "config"] as const)("retires a pending retry on %s", async (change) => {
    vi.useFakeTimers();
    const f = startupTaskFixture();
    f.prepare.mockRejectedValueOnce(new Error("temporary registration failure"));
    try {
      f.preparation.request();
      await f.firstRetry.promise;
      if (change === "abort") {
        f.abort.abort();
      } else {
        f.configChanged();
      }
      await f.tasks[0];
      if (change === "config") {
        await f.tasks[1];
      }
      expect(f.prepare).toHaveBeenCalledTimes(change === "abort" ? 1 : 2);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(f.prepare).toHaveBeenCalledTimes(change === "abort" ? 1 : 2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });

  it("admits a configured private channel with DMs disabled, but enforces the room allowlist", async () => {
    const f = fixture();
    const cfg: CoreConfig = {
      ...f.cfg,
      channels: {
        matrix: {
          dm: { enabled: false },
          groups: { [roomId]: { enabled: true } },
        },
      },
    };
    f.params.getRuntimeConfig = () => cfg;
    f.params.groupPolicy = "allowlist";
    f.params.directTracker = createDirectRoomTracker(f.client as unknown as MatrixClient, {
      isExplicitlyConfiguredRoom: () => true,
    });
    try {
      await prepareMatrixStartupConversationRoots(f.params);
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(f.prepare.mock.calls[0]![0].scope.conversation.kind).toBe("channel");
      cfg.channels!.matrix!.groups = { "!other:example.test": { enabled: true } };
      await prepareMatrixStartupConversationRoots(f.params);
      expect(f.prepare).toHaveBeenCalledOnce();
    } finally {
      f.abort.abort();
      f.params.directTracker.dispose();
      f.tracker.dispose();
    }
  });

  it("requalifies skipped endpoints on actual config and room signals without input or polling", async () => {
    const f = fixture();
    const log = vi.fn();
    f.params.runtime.log = log;
    const tasks: Promise<void>[] = [];
    const unsubscribe = vi.fn();
    let configChanged = () => {};
    vi.mocked(f.core.config.subscribe).mockImplementation((listener) => {
      configChanged = listener;
      return unsubscribe;
    });
    const preparation = createMatrixStartupRootPreparation({
      ...f.params,
      runTask(task) {
        const pending = Promise.resolve().then(task);
        tasks.push(pending);
        return pending;
      },
    });
    try {
      // The first full native privacy read fails; no core registration exists yet.
      f.client.doRequest.mockResolvedValueOnce([]);
      preparation.request();
      await tasks[0];
      expect(f.prepare).not.toHaveBeenCalled();
      configChanged();
      configChanged();
      await tasks[1];
      expect(f.prepare).toHaveBeenCalledOnce();
      const first = f.prepare.mock.calls[0]![0];
      first.onRootPreparationState?.("registered");
      first.onRootPreparationState?.("prepared");
      first.onRootPreparationState?.("prepared");
      // Ordinary successful completion causes no second pass.
      expect(tasks).toHaveLength(2);
      preparation.request(roomId);
      preparation.request(roomId);
      await tasks[2];
      expect(first.signal?.aborted).toBe(true);
      expect(f.prepare).toHaveBeenCalledTimes(2);
      expect(f.admit).not.toHaveBeenCalled();
      const text = JSON.stringify(log.mock.calls);
      expect(text).toContain("prepared");
      expect(text).not.toContain(roomId);
      expect(text).not.toContain(person);
    } finally {
      f.abort.abort();
      f.tracker.dispose();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    const count = tasks.length;
    configChanged();
    expect(tasks).toHaveLength(count);
  });

  it("qualifies native private endpoints once without a user message, dispatch or account-data repair", async () => {
    const f = fixture();
    try {
      await prepareMatrixStartupConversationRoots(f.params);
      expect(f.prepare).toHaveBeenCalledOnce();
      const prepared = f.prepare.mock.calls[0]![0];
      expect(prepared).toMatchObject({
        purpose: "root-preparation",
        signal: f.abort.signal,
        scope: {
          rawPrincipalRef: person,
          binding: { nativeChannelId: roomId, inboundEventKind: "room_event" },
        },
      });
      expect(prepared.scope.binding).not.toHaveProperty("messageId");
      expect(prepared.ingress.state.event).toMatchObject({
        kind: "conversation",
        authMode: "inbound",
        mayPair: false,
      });
      expect(f.admit).not.toHaveBeenCalled();
      expect(f.core.channel.inbound.dispatch).not.toHaveBeenCalled();
      f.tracker.invalidateRoom(roomId);
      // The ingress private-room proof stays with the original native host handoff,
      // not an invented user identity. Core tests consume and retain that proof.
      expect(f.client.doRequest).toHaveBeenCalledOnce();
    } finally {
      f.abort.abort();
      f.tracker.dispose();
    }
  });

  it("does not prepare policy-denied private peers or shared audiences", async () => {
    const f = fixture();
    try {
      f.cfg.channels!.matrix!.dm!.allowFrom = ["@other:example.test"];
      await prepareMatrixStartupConversationRoots(f.params);
      expect(f.prepare).not.toHaveBeenCalled();
      f.cfg.channels!.matrix!.dm!.allowFrom = [person];
      f.client.getJoinedRoomMembers.mockResolvedValue([self, person, "@guest:example.test"]);
      await prepareMatrixStartupConversationRoots(f.params);
      expect(f.prepare).not.toHaveBeenCalled();
    } finally {
      f.abort.abort();
      f.tracker.dispose();
    }
  });

  it("rechecks account revocation after awaited membership and stops before acquiring private context", async () => {
    const f = fixture();
    try {
      f.client.getJoinedRoomMembers.mockImplementation(async () => {
        f.abort.abort();
        return [self, person];
      });
      await expect(prepareMatrixStartupConversationRoots(f.params)).rejects.toThrow();
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.client.doRequest).not.toHaveBeenCalled();
    } finally {
      f.tracker.dispose();
    }
  });

  it("rechecks the original runtime config after awaiting privacy evidence", async () => {
    const f = fixture();
    try {
      let current = f.cfg;
      f.params.getRuntimeConfig = () => current;
      f.client.doRequest.mockImplementation(async () => {
        current = { ...f.cfg };
        return [];
      });
      await expect(prepareMatrixStartupConversationRoots(f.params)).rejects.toThrow(
        "configuration changed",
      );
      expect(f.prepare).not.toHaveBeenCalled();
    } finally {
      f.abort.abort();
      f.tracker.dispose();
    }
  });

  it("refuses in-place changes from a mutable scoped getter after awaiting native privacy", async () => {
    const f = fixture();
    try {
      f.client.doRequest.mockImplementation(async () => {
        f.cfg.channels.matrix.dm.allowFrom = ["@other:example.test"];
        return [];
      });
      await expect(prepareMatrixStartupConversationRoots(f.params)).rejects.toThrow(
        "configuration changed",
      );
      expect(f.prepare).not.toHaveBeenCalled();
    } finally {
      f.abort.abort();
      f.tracker.dispose();
    }
  });

  it("uses the native publication capture and revokes it when the same origin is republished", async () => {
    const f = fixture();
    const previous = getRuntimeConfigSnapshot();
    try {
      setRuntimeConfigSnapshot(f.cfg);
      await prepareMatrixStartupConversationRoots(f.params);
      expect(f.prepare).toHaveBeenCalledOnce();
      const prepared = f.prepare.mock.calls[0]![0];
      expect(() => prepared.assertCurrent()).not.toThrow();
      f.cfg.channels.matrix.dm.allowFrom = ["@other:example.test"];
      setRuntimeConfigSnapshot(f.cfg);
      expect(() => prepared.assertCurrent()).toThrow("configuration changed");
    } finally {
      if (previous) {
        setRuntimeConfigSnapshot(previous);
      } else {
        clearRuntimeConfigSnapshot();
      }
      f.abort.abort();
      f.tracker.dispose();
    }
  });

  it("retains an equivalent native republication while rejecting changed data or an unrelated getter", async () => {
    const f = fixture();
    const previous = getRuntimeConfigSnapshot();
    try {
      setRuntimeConfigSnapshot(f.cfg);
      f.params.getRuntimeConfig = () => getRuntimeConfigSnapshot() ?? f.cfg;
      await prepareMatrixStartupConversationRoots(f.params);
      expect(f.prepare).toHaveBeenCalledOnce();
      const prepared = f.prepare.mock.calls[0]![0];
      const next = structuredClone(f.cfg);
      setRuntimeConfigSnapshot(next);
      expect(() => prepared.assertCurrent()).not.toThrow();
      // Equal values do not turn an explicit scoped getter into the native owner.
      f.params.getRuntimeConfig = () => f.cfg;
      expect(() => prepared.assertCurrent()).toThrow("configuration changed");
      f.params.getRuntimeConfig = () => getRuntimeConfigSnapshot() ?? f.cfg;
      next.channels.matrix.dm.allowFrom = ["@other:example.test"];
      setRuntimeConfigSnapshot(next);
      expect(() => prepared.assertCurrent()).toThrow("configuration changed");
    } finally {
      if (previous) {
        setRuntimeConfigSnapshot(previous);
      } else {
        clearRuntimeConfigSnapshot();
      }
      f.abort.abort();
      f.tracker.dispose();
    }
  });
});
