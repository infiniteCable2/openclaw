import { EventType } from "matrix-js-sdk/lib/@types/event.js";
import { CallMembership } from "matrix-js-sdk/lib/matrixrtc/CallMembership.js";
import { MatrixEvent } from "matrix-js-sdk/lib/models/event.js";
import { describe, expect, it } from "vitest";
import { resolveMatrixRtcMode } from "./rtc-mode.js";

describe("resolveMatrixRtcMode", () => {
  it("selects Matrix 2.0 for a real non-expiring sticky membership", async () => {
    const membership = await CallMembership.parseFromEvent(
      new MatrixEvent({
        event_id: "$sticky",
        type: EventType.RTCMembership,
        sender: "@owner:example.test",
        origin_server_ts: Date.now(),
        content: {
          application: { type: "m.call", "m.call.intent": "audio" },
          member: {
            id: "owner-member",
            user_id: "@owner:example.test",
            device_id: "OWNERDEVICE",
          },
          slot_id: "m.call#ROOM",
          msc4354_sticky_key: "owner-member",
          versions: [],
          transports: {
            published: [{ type: "livekit", livekit_service_url: "https://rtc.example.test" }],
            can_subscribe: ["livekit"],
          },
        },
      }),
    );

    expect(resolveMatrixRtcMode(membership)).toBe("matrix_2_0");
  });

  it("selects compatibility for a real expiring legacy state membership", async () => {
    const membership = await CallMembership.parseFromEvent(
      new MatrixEvent({
        event_id: "$legacy",
        type: EventType.GroupCallMemberPrefix,
        state_key: "_@owner:example.test_OWNERDEVICE_m.call",
        sender: "@owner:example.test",
        origin_server_ts: Date.now(),
        content: {
          application: "m.call",
          call_id: "",
          device_id: "OWNERDEVICE",
          scope: "m.room",
          created_ts: Date.now(),
          expires: 60_000,
          membershipID: "owner-member",
          focus_active: { type: "livekit", focus_selection: "oldest_membership" },
          foci_preferred: [
            {
              type: "livekit",
              livekit_service_url: "https://rtc.example.test",
              livekit_alias: "!room:example.test",
            },
          ],
          "m.call.intent": "audio",
        },
      }),
    );

    expect(resolveMatrixRtcMode(membership)).toBe("compatibility");
  });
});
