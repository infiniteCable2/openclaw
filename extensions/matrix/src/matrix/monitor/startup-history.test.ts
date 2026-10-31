import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { createDirectRoomTracker } from "./direct.js";
import { prepareMatrixStartupConversationRoots } from "./startup-history.js";

const roomId = "!private:example.test";
const self = "@assistant:example.test";
const person = "@person:example.test";

function fixture() {
  const cfg: CoreConfig = {
    channels: { matrix: { dm: { policy: "allowlist", allowFrom: [person] } } },
    agents: { entries: { main: { conversationMode: "branches" } } },
  };
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
    runtime: { log: vi.fn() },
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

afterEach(() => vi.restoreAllMocks());

describe("healthy Matrix startup root preparation", () => {
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
});
