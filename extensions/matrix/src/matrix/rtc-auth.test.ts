import { describe, expect, it, vi } from "vitest";
import { requestMatrixRtcCredentials } from "./rtc-auth.js";

const openIdToken = {
  access_token: "openid",
  token_type: "Bearer",
  matrix_server_name: "example.org",
  expires_in: 3600,
};

describe("MatrixRTC authorization", () => {
  it("uses the Matrix 2.0 token contract without logging or query credentials", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "wss://rtc.example.org/livekit/sfu", jwt: "jwt" }), {
        status: 200,
      }),
    );
    await expect(
      requestMatrixRtcCredentials({
        mode: "matrix_2_0",
        authServiceUrl: "https://rtc.example.org/livekit/jwt",
        roomId: "!room:example.org",
        slotId: "m.call#ROOM",
        membership: {
          userId: "@bot:example.org",
          deviceId: "DEVICE",
          memberId: "member",
        },
        openIdToken,
        fetchFn,
      }),
    ).resolves.toEqual({ url: "wss://rtc.example.org/livekit/sfu", token: "jwt" });

    const [url, init] = fetchFn.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://rtc.example.org/livekit/jwt/get_token");
    if (typeof init.body !== "string") {
      throw new Error("Expected a JSON string request body");
    }
    expect(JSON.parse(init.body)).toEqual({
      room_id: "!room:example.org",
      slot_id: "m.call#ROOM",
      openid_token: openIdToken,
      member: {
        id: "member",
        claimed_user_id: "@bot:example.org",
        claimed_device_id: "DEVICE",
      },
    });
  });

  it("uses the legacy token contract for compatibility memberships", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "wss://rtc.example.org/livekit/sfu", jwt: "jwt" }), {
        status: 200,
      }),
    );
    await expect(
      requestMatrixRtcCredentials({
        mode: "compatibility",
        authServiceUrl: "https://rtc.example.org/livekit/jwt",
        roomId: "!room:example.org",
        slotId: "m.call#ROOM",
        membership: {
          userId: "@bot:example.org",
          deviceId: "DEVICE",
          memberId: "member",
        },
        openIdToken,
        fetchFn,
      }),
    ).resolves.toEqual({ url: "wss://rtc.example.org/livekit/sfu", token: "jwt" });

    const [url, init] = fetchFn.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://rtc.example.org/livekit/jwt/sfu/get");
    if (typeof init.body !== "string") {
      throw new Error("Expected a JSON string request body");
    }
    expect(JSON.parse(init.body)).toEqual({
      room: "!room:example.org",
      openid_token: openIdToken,
      device_id: "DEVICE",
    });
  });

  it("rejects a LiveKit URL redirected to another host", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "wss://attacker.example/sfu", jwt: "jwt" }), {
        status: 200,
      }),
    );
    await expect(
      requestMatrixRtcCredentials({
        mode: "matrix_2_0",
        authServiceUrl: "https://rtc.example.org/livekit/jwt",
        roomId: "!room:example.org",
        slotId: "m.call#ROOM",
        membership: { userId: "@bot:example.org", deviceId: "DEVICE", memberId: "member" },
        openIdToken,
        fetchFn,
      }),
    ).rejects.toThrow("untrusted LiveKit URL");
  });
});
