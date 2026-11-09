import { MatrixEvent } from "matrix-js-sdk/lib/models/event.js";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import { matrixEventToRaw } from "../sdk/event-helpers.js";
import {
  resolveMatrixEndpointPolicy,
  resolveMatrixMonitorAccessState,
  resolveMatrixMonitorCommandAccess,
} from "./access-state.js";
import { resolveMatrixRoomConfig } from "./rooms.js";

beforeEach(() => setMatrixRuntime(createPluginRuntimeMock()));
const alice = "@alice:example.org";
type AccessInput = Partial<Parameters<typeof resolveMatrixMonitorAccessState>[0]>;

function resolveAccess(overrides: AccessInput) {
  return resolveMatrixMonitorAccessState({
    allowFrom: [],
    storeAllowFrom: [],
    groupAllowFrom: [],
    roomUsers: [],
    senderId: alice,
    isRoom: true,
    ...overrides,
  });
}

async function expectBlockedCommand(state: Awaited<ReturnType<typeof resolveAccess>>) {
  const access = await resolveMatrixMonitorCommandAccess(state, {
    allowTextCommands: true,
    hasControlCommand: true,
  });
  expect(access).toMatchObject({ authorized: false, shouldBlockControlCommand: true });
}

describe("resolveMatrixMonitorAccessState", () => {
  const endpointPolicyCases: Array<{
    direct: boolean;
    dmEnabled?: boolean;
    groupPolicy: Parameters<typeof resolveMatrixEndpointPolicy>[0]["groupPolicy"];
    rooms?: Parameters<typeof resolveMatrixRoomConfig>[0]["rooms"];
    reason: ReturnType<typeof resolveMatrixEndpointPolicy>;
  }> = [
    { direct: true, dmEnabled: false, groupPolicy: "open", reason: "dm-disabled" },
    { direct: false, dmEnabled: false, groupPolicy: "open", reason: undefined },
    { direct: false, groupPolicy: "disabled", reason: "group-disabled" },
    { direct: false, groupPolicy: "allowlist", reason: "room-allowlist-missing" },
    {
      direct: false,
      groupPolicy: "allowlist",
      rooms: { "!other:example.test": {} },
      reason: "room-not-allowlisted",
    },
    {
      direct: false,
      groupPolicy: "open",
      rooms: { "!other:example.test": {} },
      reason: undefined,
    },
    {
      direct: false,
      groupPolicy: "open",
      rooms: { "!target:example.test": { enabled: false } },
      reason: "room-disabled",
    },
  ];
  it.each(endpointPolicyCases)(
    "uses the same endpoint gate for input and registration (%j)",
    (entry) => {
      expect(
        resolveMatrixEndpointPolicy({
          isDirectMessage: entry.direct,
          dmEnabled: entry.dmEnabled,
          groupPolicy: entry.groupPolicy,
          room: resolveMatrixRoomConfig({
            roomId: "!target:example.test",
            aliases: [],
            rooms: entry.rooms,
          }),
        }),
      ).toBe(entry.reason);
    },
  );

  it.each([
    { eventSender: "@Alice:example.test", allowed: true },
    { eventSender: "@other:example.test", allowed: false },
  ])(
    "verifies the SDK event sender without adopting content identity ($eventSender)",
    async ({ eventSender, allowed }) => {
      const runtime = createPluginRuntimeMock();
      const createResolver = vi.spyOn(runtime.channel.inbound.ingress, "createResolver");
      setMatrixRuntime(runtime);
      const senderId = "@Alice:example.test";
      const event = matrixEventToRaw(
        new MatrixEvent({
          event_id: "$message:example.test",
          room_id: "!direct:example.test",
          type: "m.room.message",
          sender: eventSender,
          content: { msgtype: "m.text", body: `I am ${senderId}`, sender: senderId },
        }),
      );
      try {
        const state = await resolveMatrixMonitorAccessState({
          allowFrom: [senderId],
          storeAllowFrom: [],
          groupAllowFrom: [],
          roomUsers: [],
          senderId: event.sender,
          isRoom: false,
          dmPolicy: "allowlist",
        });
        const identity = createResolver.mock.calls[0]?.[0].identity;
        expect(identity?.resolveParticipant?.({ stableId: event.sender })).toEqual({
          domain: "example.test",
          idKind: "user-id",
          id: eventSender,
        });
        expect(identity?.resolveParticipant?.({ stableId: "Alice" })).toBeUndefined();
        expect(identity?.primary.authentication).toBe("verified");
        expect(state.messageIngress.ingress.decision).toBe(allowed ? "allow" : "block");
        const match = state.messageIngress.state.allowlists.dm.match;
        if (allowed) {
          expect(match.matchedPairs).toEqual([
            expect.objectContaining({ subjectAuthentication: "verified" }),
          ]);
        } else {
          expect(match).toMatchObject({ matched: false, matchedEntryIds: [] });
        }
        expect(
          await resolveMatrixMonitorCommandAccess(state, {
            useAccessGroups: true,
            allowTextCommands: true,
            hasControlCommand: true,
          }),
        ).toMatchObject({ authorized: allowed, shouldBlockControlCommand: !allowed });
      } finally {
        createResolver.mockRestore();
      }
    },
  );

  it("normalizes group allowlists and uses shared ingress matching", async () => {
    const state = await resolveAccess({
      groupAllowFrom: ["@Carol:Example.org"],
      roomUsers: ["user:@Dana:Example.org"],
      senderId: "@Dana:Example.org",
      groupPolicy: "allowlist",
    });

    expect(state.messageIngress.ingress.decision).toBe("allow");
  });

  it.each([
    { isRoom: false, allowFrom: ["@\u212A:example.org"], groupAllowFrom: [] },
    { isRoom: true, allowFrom: [], groupAllowFrom: ["@\u212A:example.org"] },
  ])("rejects case-folding collisions at ingress and command gates", async (params) => {
    const state = await resolveAccess({
      ...params,
      senderId: "@k:example.org",
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
    });

    expect(state.messageIngress.ingress.decision).toBe("block");
    await expectBlockedCommand(state);
  });

  it("does not let pairing-store entries authorize open DMs without wildcard", async () => {
    const state = await resolveAccess({
      storeAllowFrom: [alice],
      dmPolicy: "open",
      isRoom: false,
    });

    expect(state.messageIngress).toMatchObject({
      senderAccess: { effectiveAllowFrom: [], decision: "block" },
      ingress: { reasonCode: "dm_policy_not_allowlisted" },
    });
  });

  it.each<[string, AccessInput]>([
    ["group", { groupAllowFrom: ["Alice"], groupPolicy: "allowlist" }],
    ["room users", { roomUsers: ["Alice"], groupPolicy: "open" }],
  ])("denies ingress and commands for unresolved %s", async (_source, entries) => {
    const state = await resolveAccess(entries);
    expect(state.messageIngress.ingress).toMatchObject({
      decision: "block",
      reasonCode: "group_policy_not_allowlisted",
    });
    await expectBlockedCommand(state);
  });

  it("keeps room-user allowlists out of dm traffic", async () => {
    const state = await resolveAccess({
      groupAllowFrom: ["@carol:example.org"],
      roomUsers: ["@dana:example.org"],
      senderId: "@dana:example.org",
      isRoom: false,
    });

    expect(state.messageIngress.senderAccess.decision).toBe("pairing");
    await expectBlockedCommand(state);
  });
});
