import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { createMatrixMonitorEventsTestHarness } from "./events.test-helpers.js";
import { EventType } from "./types.js";

beforeEach(() => installMatrixMonitorTestRuntime());

describe("Matrix private recipient evidence invalidation", () => {
  it.each([
    { type: "m.room.history_visibility", content: { history_visibility: "world_readable" } },
    { type: "m.room.join_rules", content: { join_rule: "public" } },
    { type: "m.room.third_party_invite", content: { display_name: "Another reader" } },
  ])("revokes only the affected room's evidence when $type changes", ({ type, content }) => {
    const fixture = createMatrixMonitorEventsTestHarness({ onRoomMessage: vi.fn() });
    fixture.roomEventListener("!room:example.org", {
      event_id: "$privacy-state-change",
      sender: "@alice:example.org",
      type,
      state_key: "",
      origin_server_ts: Date.now(),
      content,
    });
    expect(fixture.invalidatePrivateAudiences).toHaveBeenCalledExactlyOnceWith("!room:example.org");
    expect(fixture.invalidateRoom).not.toHaveBeenCalled();
  });

  it("invalidates the direct-room and member-name caches on membership changes", () => {
    const fixture = createMatrixMonitorEventsTestHarness({ onRoomMessage: vi.fn() });
    fixture.roomEventListener("!room:example.org", {
      event_id: "$member1",
      sender: "@alice:example.org",
      state_key: "@mallory:example.org",
      type: EventType.RoomMember,
      origin_server_ts: Date.now(),
      content: { membership: "join" },
    });
    expect(fixture.invalidateRoom).toHaveBeenCalledWith("!room:example.org");
    expect(fixture.invalidateMemberDisplayName).toHaveBeenCalledWith(
      "!room:example.org",
      "@mallory:example.org",
    );
  });
});
