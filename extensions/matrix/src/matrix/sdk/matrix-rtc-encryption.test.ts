import { EventType } from "matrix-js-sdk/lib/@types/event.js";
import { createClient } from "matrix-js-sdk/lib/matrix.js";
import { Room } from "matrix-js-sdk/lib/models/room.js";
import { describe, expect, it, vi } from "vitest";

describe("MatrixRTC sticky membership encryption", () => {
  it("sends RTC membership in the clear in an encrypted room", async () => {
    const requests: URL[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      requests.push(new URL(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ event_id: "$event" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const userId = "@bot:example.org";
    const roomId = "!room:example.org";
    const client = createClient({
      baseUrl: "https://matrix.example.org",
      accessToken: "test-token",
      userId,
      deviceId: "DEVICE",
      fetchFn,
    });
    const room = new Room(roomId, client, userId);
    vi.spyOn(room, "hasEncryptionStateEvent").mockReturnValue(true);
    vi.spyOn(client, "doesServerSupportUnstableFeature").mockResolvedValue(true);
    client.store.storeRoom(room);

    await client["_unstable_sendStickyEvent"](roomId, 60_000, null, EventType.RTCMembership, {
      msc4354_sticky_key: "member",
    });

    expect(requests).toHaveLength(1);
    expect(decodeURIComponent(requests[0]!.pathname)).toContain(
      `/send/${EventType.RTCMembership}/`,
    );
    expect(requests[0]!.searchParams.get("org.matrix.msc4354.sticky_duration_ms")).toBe("60000");
  });
});
