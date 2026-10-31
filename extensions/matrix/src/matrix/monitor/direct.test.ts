import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { EventType } from "../send/types.js";
import { createDirectRoomTracker } from "./direct.js";

type MockStateEvents = Record<string, Record<string, unknown>>;
type MockRoomStateEvent = { type: string; state_key: string; content: Record<string, unknown> };

const DEFAULT_DIRECT_CHECK = {
  roomId: "!room:example.org",
  senderId: "@alice:example.org",
};

function checkDefaultRoom(tracker: ReturnType<typeof createDirectRoomTracker>) {
  return tracker.isDirectMessage(DEFAULT_DIRECT_CHECK);
}

function createMockClient(params: {
  isDm?: boolean;
  members?: string[];
  stateEvents?: MockStateEvents;
  dmCacheAvailable?: boolean;
  directAccountData?: Record<string, string[]>;
  setAccountDataError?: Error;
  roomState?: unknown;
}) {
  let members = params.members ?? ["@alice:example.org", "@bot:example.org"];
  const stateEvents = params.stateEvents ?? {};
  let directAccountData = params.directAccountData ?? {};
  const dmRoomIds = new Set<string>();
  if (params.isDm === true) {
    dmRoomIds.add("!room:example.org");
  }
  const roomStateForTest = (roomId = DEFAULT_DIRECT_CHECK.roomId): MockRoomStateEvent[] => [
    { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } },
    { type: "m.room.join_rules", state_key: "", content: { join_rule: "invite" } },
    ...members.map((id) => ({
      type: "m.room.member",
      state_key: id,
      content: { membership: "join", ...stateEvents[`${roomId}|m.room.member|${id}`] },
    })),
  ];
  return {
    dms: {
      update: vi.fn().mockResolvedValue(params.dmCacheAvailable !== false),
      isDm: vi.fn().mockImplementation((roomId: string) => dmRoomIds.has(roomId)),
    },
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    getAccountData: vi
      .fn()
      .mockImplementation(async (eventType: string) =>
        eventType === EventType.Direct ? directAccountData : undefined,
      ),
    getJoinedRoomMembers: vi.fn().mockImplementation(async () => members),
    doRequest: vi.fn().mockImplementation(async (_method: string, endpoint: string) => {
      if (Object.hasOwn(params, "roomState")) {
        return params.roomState;
      }
      const roomId = decodeURIComponent(endpoint.split("/").at(-2) ?? "");
      return roomStateForTest(roomId);
    }),
    roomStateForTest,
    getRoomStateEvent: vi
      .fn()
      .mockImplementation(async (roomId: string, eventType: string, stateKey = "") => {
        const key = `${roomId}|${eventType}|${stateKey}`;
        const state = stateEvents[key];
        if (state === undefined) {
          throw new Error(`State event not found: ${key}`);
        }
        return state;
      }),
    setAccountData: vi.fn().mockImplementation(async (eventType: string, content: unknown) => {
      if (params.setAccountDataError) {
        throw params.setAccountDataError;
      }
      if (eventType !== EventType.Direct) {
        return;
      }
      directAccountData = (content as Record<string, string[]>) ?? {};
      dmRoomIds.clear();
      for (const value of Object.values(directAccountData)) {
        if (!Array.isArray(value)) {
          continue;
        }
        for (const roomId of value) {
          if (typeof roomId === "string" && roomId.trim()) {
            dmRoomIds.add(roomId);
          }
        }
      }
    }),
    setMembersForTest(next: string[]) {
      members = next;
    },
  } as unknown as MatrixClient & {
    dms: {
      update: Mock<MatrixClient["dms"]["update"]>;
      isDm: ReturnType<typeof vi.fn>;
    };
    getAccountData: ReturnType<typeof vi.fn>;
    getJoinedRoomMembers: ReturnType<typeof vi.fn>;
    getRoomStateEvent: ReturnType<typeof vi.fn>;
    doRequest: Mock<MatrixClient["doRequest"]>;
    roomStateForTest: typeof roomStateForTest;
    setAccountData: ReturnType<typeof vi.fn>;
    setMembersForTest: (members: string[]) => void;
  };
}

describe("createDirectRoomTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("proves a configured private room without changing its channel routing", async () => {
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client, { isExplicitlyConfiguredRoom: () => true });
    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
    const proof = await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK);
    expect(proof).toBeDefined();
    expect(() => proof?.assertCurrent()).not.toThrow();
    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
    expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
    expect(client.doRequest).toHaveBeenCalledWith(
      "GET",
      "/_matrix/client/v3/rooms/!room%3Aexample.org/state",
    );
    expect(client.dms.update).toHaveBeenCalledTimes(1);
    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("uses fresh membership instead of supplied hints or the routing cache", async () => {
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
    client.setMembersForTest(["@alice:example.org", "@bot:example.org", "@extra:example.org"]);
    await expect(
      tracker.preparePrivateAudience({
        ...DEFAULT_DIRECT_CHECK,
        joinedMembers: ["@alice:example.org", "@bot:example.org"],
      }),
    ).resolves.toBeUndefined();
    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(1);
    expect(client.doRequest).toHaveBeenCalledTimes(1);
  });

  it("accepts a positive self member flag without falling back to routing promotion", async () => {
    const client = createMockClient({
      stateEvents: {
        "!room:example.org|m.room.member|@bot:example.org": { is_direct: true },
      },
    });
    const tracker = createDirectRoomTracker(client);
    expect(await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK)).toBeDefined();
    expect(client.dms.update).not.toHaveBeenCalled();
    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it.each([
    { history: "shared", join: "invite", allowed: true },
    { history: "invited", join: "invite", allowed: true },
    { history: "joined", join: "invite", allowed: true },
    { history: "shared", join: "knock", allowed: true },
    { history: undefined, join: undefined, allowed: true },
    { history: "world_readable", join: "invite", allowed: false },
    { history: "unknown", join: "invite", allowed: false },
    { history: "shared", join: "public", allowed: false },
    { history: "joined", join: "public", allowed: false },
    { history: "shared", join: "restricted", allowed: false },
    { history: "shared", join: "knock_restricted", allowed: false },
    { history: "shared", join: "private", allowed: false },
    { history: "shared", join: "unknown", allowed: false },
  ])(
    "checks protected history=$history and explicit admission=$join",
    async ({ history, join, allowed }) => {
      const client = createMockClient({ isDm: true });
      const state = client.roomStateForTest().filter((event) => event.type === "m.room.member");
      if (history !== undefined) {
        state.push({
          type: "m.room.history_visibility",
          state_key: "",
          content: { history_visibility: history },
        });
      }
      if (join !== undefined) {
        state.push({ type: "m.room.join_rules", state_key: "", content: { join_rule: join } });
      }
      client.doRequest.mockResolvedValue(state);
      const proof =
        await createDirectRoomTracker(client).preparePrivateAudience(DEFAULT_DIRECT_CHECK);
      expect(Boolean(proof)).toBe(allowed);
    },
  );

  it.each([undefined, null, {}, [null], [{ type: "m.room.member", content: {} }]])(
    "refuses unavailable or malformed full room state %#",
    async (roomState) => {
      await expect(
        createDirectRoomTracker(createMockClient({ isDm: true, roomState })).preparePrivateAudience(
          DEFAULT_DIRECT_CHECK,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it.each(["m.room.history_visibility", "m.room.join_rules"])(
    "does not apply protocol defaults to a malformed explicit %s event",
    async (type) => {
      const client = createMockClient({ isDm: true });
      const state = client.roomStateForTest();
      for (const event of state) {
        if (event.type === type) {
          event.content = {};
        }
      }
      client.doRequest.mockResolvedValue(state);
      await expect(
        createDirectRoomTracker(client).preparePrivateAudience(DEFAULT_DIRECT_CHECK),
      ).resolves.toBeUndefined();
    },
  );

  it.each(["shared", "invited", "joined"])(
    "checks whether a third invitee can receive events with %s history",
    async (history) => {
      const client = createMockClient({ isDm: true });
      const state = client.roomStateForTest();
      for (const event of state) {
        if (event.type === "m.room.history_visibility") {
          event.content = { history_visibility: history };
        }
      }
      state.push({
        type: "m.room.member",
        state_key: "@invitee:example.org",
        content: { membership: "invite" },
      });
      client.doRequest.mockResolvedValue(state);
      const proof =
        await createDirectRoomTracker(client).preparePrivateAudience(DEFAULT_DIRECT_CHECK);
      expect(Boolean(proof)).toBe(history === "joined");
    },
  );

  it("does not expose shared history through an outstanding third-party invitation", async () => {
    const client = createMockClient({ isDm: true });
    client.doRequest.mockResolvedValue([
      ...client.roomStateForTest(),
      {
        type: "m.room.third_party_invite",
        state_key: "synthetic-invite-token",
        content: { display_name: "Invitee" },
      },
    ]);
    await expect(
      createDirectRoomTracker(client).preparePrivateAudience(DEFAULT_DIRECT_CHECK),
    ).resolves.toBeUndefined();
  });

  it.each([
    "group",
    "other-person",
    "unknown",
    "negative-flag",
    "members-fail",
    "self-fail",
    "dm-fail",
  ])("refuses private audience evidence for %s", async (kind) => {
    const client = createMockClient({
      isDm: kind !== "unknown",
      stateEvents:
        kind === "negative-flag"
          ? {
              "!room:example.org|m.room.member|@bot:example.org": { is_direct: false },
            }
          : {},
    });
    if (kind === "group") {
      client.setMembersForTest(["@alice:example.org", "@bot:example.org", "@extra:example.org"]);
    }
    if (kind === "other-person") {
      client.setMembersForTest(["@other:example.org", "@bot:example.org"]);
    }
    if (kind === "members-fail") {
      client.doRequest.mockRejectedValueOnce(new Error("unavailable"));
    }
    if (kind === "self-fail") {
      client.getUserId = vi.fn().mockRejectedValueOnce(new Error("unavailable"));
    }
    if (kind === "dm-fail") {
      client.dms.update.mockRejectedValueOnce(new Error("unavailable"));
    }
    await expect(
      createDirectRoomTracker(client).preparePrivateAudience(DEFAULT_DIRECT_CHECK),
    ).resolves.toBeUndefined();
  });

  it("rejects a caller's mismatched self identity or malformed remote identity", async () => {
    const tracker = createDirectRoomTracker(createMockClient({ isDm: true }));
    await expect(
      tracker.preparePrivateAudience({ ...DEFAULT_DIRECT_CHECK, selfUserId: "@other:example.org" }),
    ).resolves.toBeUndefined();
    await expect(
      tracker.preparePrivateAudience({ ...DEFAULT_DIRECT_CHECK, senderId: "alice" }),
    ).resolves.toBeUndefined();
  });

  it.each(["self", "state", "dm"] as const)(
    "refuses room invalidation during the awaited %s preparation",
    async (stage) => {
      const client = createMockClient({ isDm: true });
      const tracker = createDirectRoomTracker(client);
      const invalidate = () => tracker.invalidateRoom(DEFAULT_DIRECT_CHECK.roomId);
      if (stage === "self") {
        client.getUserId = vi.fn().mockImplementationOnce(async () => {
          invalidate();
          return "@bot:example.org";
        });
      }
      if (stage === "state") {
        client.doRequest.mockImplementationOnce(async () => {
          invalidate();
          return client.roomStateForTest();
        });
      }
      if (stage === "dm") {
        client.dms.update.mockImplementationOnce(async () => {
          invalidate();
          return true;
        });
      }
      await expect(tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK)).resolves.toBeUndefined();
    },
  );

  it("never revives a held proof after membership invalidation and restoration", async () => {
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);
    const first = await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK);
    expect(first).toBeDefined();
    tracker.invalidateRoom(DEFAULT_DIRECT_CHECK.roomId);
    client.setMembersForTest(["@alice:example.org", "@bot:example.org", "@extra:example.org"]);
    await expect(tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK)).resolves.toBeUndefined();
    client.setMembersForTest(["@alice:example.org", "@bot:example.org"]);
    const next = await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK);
    expect(next).toBeDefined();
    expect(() => next?.assertCurrent()).not.toThrow();
    expect(() => first?.assertCurrent()).toThrow("no longer current");
  });

  it("holds evidence through long turns but never revives an invalidated token on refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
    const tracker = createDirectRoomTracker(createMockClient({ isDm: true }));
    const first = await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK);
    expect(first).toBeDefined();
    vi.setSystemTime(new Date("2026-03-12T11:00:00Z"));
    expect(() => first?.assertCurrent()).not.toThrow();
    tracker.invalidatePrivateAudiences();
    const next = await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK);
    expect(next).toBeDefined();
    expect(() => first?.assertCurrent()).toThrow("no longer current");
    expect(() => next?.assertCurrent()).not.toThrow();
    vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
    expect(() => first?.assertCurrent()).toThrow("no longer current");
  });

  it("globally revokes private audiences without changing routing caches", async () => {
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
    const first = await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK);
    expect(first).toBeDefined();
    const membershipReads = client.getJoinedRoomMembers.mock.calls.length;
    const dmReads = client.dms.update.mock.calls.length;
    tracker.invalidatePrivateAudiences();
    expect(() => first?.assertCurrent()).toThrow("no longer current");
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(membershipReads);
    expect(client.dms.update).toHaveBeenCalledTimes(dmReads);
    expect(await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK)).toBeDefined();
    expect(() => first?.assertCurrent()).toThrow("no longer current");
  });

  it("revokes a room's private evidence without revoking another room", async () => {
    const client = createMockClient({});
    client.dms.isDm.mockReturnValue(true);
    const tracker = createDirectRoomTracker(client);
    const first = await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK);
    const other = await tracker.preparePrivateAudience({
      ...DEFAULT_DIRECT_CHECK,
      roomId: "!other:example.org",
    });
    expect(first).toBeDefined();
    expect(other).toBeDefined();
    tracker.invalidatePrivateAudiences(DEFAULT_DIRECT_CHECK.roomId);
    expect(() => first?.assertCurrent()).toThrow("no longer current");
    expect(() => other?.assertCurrent()).not.toThrow();
  });

  it("refuses global privacy invalidation during an awaited preparation", async () => {
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);
    client.doRequest.mockImplementationOnce(async () => {
      tracker.invalidatePrivateAudiences();
      return client.roomStateForTest();
    });
    await expect(tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK)).resolves.toBeUndefined();
  });

  it("allows a fresh proof after healthy sync resumes without reviving an older proof", async () => {
    let healthy = true;
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client, { isAudienceCurrent: () => healthy });
    const first = await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK);
    expect(first).toBeDefined();
    healthy = false;
    expect(() => first?.assertCurrent()).toThrow("no longer current");
    await expect(tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK)).resolves.toBeUndefined();
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
    healthy = true;
    const next = await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK);
    expect(next).toBeDefined();
    expect(() => next?.assertCurrent()).not.toThrow();
    expect(() => first?.assertCurrent()).toThrow("no longer current");
  });

  it("refuses sync health loss while membership preparation is pending", async () => {
    let healthy = true;
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client, { isAudienceCurrent: () => healthy });
    client.doRequest.mockImplementationOnce(async () => {
      healthy = false;
      return client.roomStateForTest();
    });
    await expect(tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK)).resolves.toBeUndefined();
    healthy = true;
    expect(await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK)).toBeDefined();
  });

  it.each(["dispose", "owner"])(
    "revokes held and future proofs when %s becomes inactive",
    async (kind) => {
      let ownerCurrent = true;
      const tracker = createDirectRoomTracker(createMockClient({ isDm: true }), {
        isCurrent: () => ownerCurrent,
      });
      const proof = await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK);
      expect(proof).toBeDefined();
      if (kind === "dispose") {
        tracker.dispose();
      } else {
        ownerCurrent = false;
      }
      expect(() => proof?.assertCurrent()).toThrow("no longer current");
      ownerCurrent = true;
      await expect(tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK)).resolves.toBeUndefined();
    },
  );

  it("revokes an in-flight proof when its owner is disposed", async () => {
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);
    client.doRequest.mockImplementationOnce(async () => {
      tracker.dispose();
      return client.roomStateForTest();
    });
    await expect(tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK)).resolves.toBeUndefined();
  });

  it("revokes an evicted room proof permanently, even after that room is proved again", async () => {
    const client = createMockClient({});
    client.doRequest.mockImplementation(async () => {
      const state = client.roomStateForTest();
      for (const event of state) {
        if (event.type === "m.room.member" && event.state_key === "@bot:example.org") {
          event.content.is_direct = true;
        }
      }
      return state;
    });
    const tracker = createDirectRoomTracker(client);
    const first = await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK);
    expect(first).toBeDefined();
    for (let i = 0; i < 1024; i++) {
      await tracker.preparePrivateAudience({
        ...DEFAULT_DIRECT_CHECK,
        roomId: `!other-${i}:example.org`,
      });
    }
    expect(await tracker.preparePrivateAudience(DEFAULT_DIRECT_CHECK)).toBeDefined();
    expect(() => first?.assertCurrent()).toThrow("no longer current");
  });

  it("treats m.direct rooms as DMs", async () => {
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);

    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);

    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("lets explicit room config veto stale m.direct classifications", async () => {
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client, {
      isExplicitlyConfiguredRoom: (roomId) => roomId === "!room:example.org",
    });

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);

    expect(client.dms.update).not.toHaveBeenCalled();
    expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it("does not trust stale m.direct classifications for shared rooms", async () => {
    const client = createMockClient({
      isDm: true,
      members: ["@alice:example.org", "@bot:example.org", "@extra:example.org"],
    });
    const tracker = createDirectRoomTracker(client);

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);

    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not classify 2-member rooms as DMs when the dm cache refresh succeeds", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client);

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);

    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("promotes strict unmapped rooms when the per-room fallback gate allows it", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client, {
      canPromoteUnmappedStrictRoom: () => true,
    });

    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);

    expect(client.setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      "@alice:example.org": ["!room:example.org"],
    });
  });

  it("inspects startup routing without promoting or repairing account data", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client, {
      canPromoteUnmappedStrictRoom: () => true,
      canPromoteRecentInvite: () => true,
    });
    tracker.rememberInvite(DEFAULT_DIRECT_CHECK.roomId, DEFAULT_DIRECT_CHECK.senderId);
    await expect(
      tracker.isDirectMessage({ ...DEFAULT_DIRECT_CHECK, allowPromotion: false }),
    ).resolves.toBe(false);
    expect(client.setAccountData).not.toHaveBeenCalled();
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
    expect(client.setAccountData).toHaveBeenCalledOnce();
  });

  it("does not promote strict unmapped rooms when the per-room fallback gate vetoes it", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client, {
      canPromoteUnmappedStrictRoom: () => false,
    });

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);

    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("keeps using the strict 2-member fallback until the dm cache seeds successfully", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: false });
    const tracker = createDirectRoomTracker(client);

    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);

    expect(client.dms.update).toHaveBeenCalledTimes(1);
  });

  it("does not classify rooms with extra members as DMs when falling back", async () => {
    const client = createMockClient({
      isDm: false,
      members: ["@alice:example.org", "@bot:example.org", "@observer:example.org"],
      dmCacheAvailable: false,
    });
    const tracker = createDirectRoomTracker(client);

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);

    expect(client.getRoomStateEvent).not.toHaveBeenCalled();
  });

  it("does not treat sender is_direct member state as a DM signal", async () => {
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
      stateEvents: {
        "!room:example.org|m.room.member|@alice:example.org": { is_direct: true },
      },
    });
    const tracker = createDirectRoomTracker(client);

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
  });

  it("treats self is_direct member state as a DM signal", async () => {
    const client = createMockClient({
      isDm: false,
      stateEvents: {
        "!room:example.org|m.room.member|@bot:example.org": { is_direct: true },
      },
    });
    const tracker = createDirectRoomTracker(client);

    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
  });

  it("treats self is_direct false member state as a non-DM signal", async () => {
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: false,
      stateEvents: {
        "!room:example.org|m.room.member|@bot:example.org": { is_direct: false },
      },
    });
    const tracker = createDirectRoomTracker(client);

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
  });

  it("treats strict rooms from recent invites as DMs after the dm cache has seeded", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client);
    tracker.rememberInvite("!room:example.org", "@alice:example.org");

    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);

    expect(client.setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      "@alice:example.org": ["!room:example.org"],
    });
  });

  it("keeps recent invite candidates across room invalidation", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client);
    tracker.rememberInvite("!room:example.org", "@alice:example.org");
    tracker.invalidateRoom("!room:example.org");

    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
  });

  it("still rejects recent invite candidates when self member state is_direct is false", async () => {
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
      stateEvents: {
        "!room:example.org|m.room.member|@bot:example.org": { is_direct: false },
      },
    });
    const tracker = createDirectRoomTracker(client);
    tracker.rememberInvite("!room:example.org", "@alice:example.org");

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
  });

  it("does not promote recent invite candidates when local vetoes mark the room as non-DM", async () => {
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
    });
    const tracker = createDirectRoomTracker(client, {
      canPromoteRecentInvite: () => false,
    });
    tracker.rememberInvite("!room:example.org", "@alice:example.org");

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);

    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("keeps locally promoted direct rooms stable after repair failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T23:00:00Z"));
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
      setAccountDataError: new Error("account data unavailable"),
    });
    const tracker = createDirectRoomTracker(client);
    tracker.rememberInvite("!room:example.org", "@alice:example.org");

    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);

    tracker.invalidateRoom("!room:example.org");

    vi.setSystemTime(new Date("2026-03-30T23:01:00Z"));

    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
  });

  it("drops locally promoted direct rooms when room metadata later vetoes promotion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T23:00:00Z"));
    let keepLocalPromotion = true;
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
      setAccountDataError: new Error("account data unavailable"),
    });
    const tracker = createDirectRoomTracker(client, {
      canPromoteRecentInvite: () => true,
      shouldKeepLocallyPromotedDirectRoom: () => keepLocalPromotion,
    });
    tracker.rememberInvite("!room:example.org", "@alice:example.org");

    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);

    keepLocalPromotion = false;
    vi.setSystemTime(new Date("2026-03-30T23:01:00Z"));

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
  });

  it("does not classify 2-member rooms whose sender is not a joined member when falling back", async () => {
    const client = createMockClient({
      isDm: false,
      members: ["@mallory:example.org", "@bot:example.org"],
      dmCacheAvailable: false,
    });
    const tracker = createDirectRoomTracker(client);

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
  });

  it("does not re-enable the strict 2-member fallback after the dm cache has seeded", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: true });
    const tracker = createDirectRoomTracker(client);

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);

    client.dms.update.mockResolvedValue(false);
    tracker.invalidateRoom("!room:example.org");

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
  });

  it("re-checks room membership after invalidation when fallback membership changes", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: false });
    const tracker = createDirectRoomTracker(client);

    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);

    client.setMembersForTest(["@alice:example.org", "@bot:example.org", "@mallory:example.org"]);
    tracker.invalidateRoom("!room:example.org");

    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
  });

  it("bounds joined-room membership cache size", async () => {
    const client = createMockClient({ isDm: false, dmCacheAvailable: false });
    const tracker = createDirectRoomTracker(client);

    for (let i = 0; i <= 1024; i += 1) {
      await tracker.isDirectMessage({
        roomId: `!room-${i}:example.org`,
        senderId: "@alice:example.org",
      });
    }

    await tracker.isDirectMessage({
      roomId: "!room-0:example.org",
      senderId: "@alice:example.org",
    });

    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(1026);
  });

  it("refreshes dm and membership caches after the ttl expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);

    await checkDefaultRoom(tracker);
    await checkDefaultRoom(tracker);

    expect(client.dms.update).toHaveBeenCalledTimes(1);
    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-03-12T10:00:31Z"));

    await checkDefaultRoom(tracker);

    expect(client.dms.update).toHaveBeenCalledTimes(2);
    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(2);
  });

  it("caches member-state direct flag lookups until the ttl expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
    const client = createMockClient({
      isDm: false,
      dmCacheAvailable: true,
      stateEvents: {
        "!room:example.org|m.room.member|@alice:example.org": { is_direct: true },
      },
    });
    const tracker = createDirectRoomTracker(client);

    await checkDefaultRoom(tracker);
    await checkDefaultRoom(tracker);

    expect(client.getRoomStateEvent).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-03-12T10:00:31Z"));

    await checkDefaultRoom(tracker);

    expect(client.getRoomStateEvent).toHaveBeenCalledTimes(2);
  });
});
