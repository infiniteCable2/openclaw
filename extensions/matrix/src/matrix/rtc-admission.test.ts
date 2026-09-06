import { RTC_SLOT_ENCRYPTION_PER_MEMBER } from "matrix-js-sdk/lib/matrixrtc/types.js";
import { describe, expect, it } from "vitest";
import {
  assertMatrixRtcCallAdmission,
  assertMatrixRtcEncryptionCompatibility,
  assertMatrixRtcPinnedTransports,
} from "./rtc-admission.js";

const selfUserId = "@nova:example.test";
const allowedUserId = "@owner:example.test";

function admitted(overrides: Partial<Parameters<typeof assertMatrixRtcCallAdmission>[0]> = {}) {
  return assertMatrixRtcCallAdmission({
    isDirectRoom: true,
    joinedUserIds: [allowedUserId, selfUserId],
    selfUserId,
    allowedUserId,
    routedAgentId: "steffen",
    allowedAgentId: "steffen",
    memberships: [{ userId: allowedUserId }],
    ...overrides,
  });
}

describe("assertMatrixRtcCallAdmission", () => {
  it("accepts the exact direct room, route, and remote membership", () => {
    expect(admitted()).toEqual({ userId: allowedUserId });
  });

  it.each([
    [{ isDirectRoom: false }, "restricted to direct rooms"],
    [{ joinedUserIds: [allowedUserId, selfUserId, "@other:example.test"] }, "exact two-user"],
    [{ routedAgentId: "ops" }, "normal Matrix agent route"],
    [
      { memberships: [{ userId: allowedUserId }, { userId: "@other:example.test" }] },
      "unexpected Matrix identity",
    ],
    [
      { memberships: [{ userId: allowedUserId }, { userId: allowedUserId }] },
      "exactly one active membership",
    ],
  ] as const)("rejects an invalid admission", (overrides, message) => {
    expect(() => admitted(overrides)).toThrow(message);
  });
});

describe("assertMatrixRtcPinnedTransports", () => {
  it("accepts normalized URLs for the pinned LiveKit authorization service", () => {
    expect(() =>
      assertMatrixRtcPinnedTransports({
        pinnedAuthServiceUrl: "https://rtc.example.test",
        homeserverLivekitServiceUrl: "https://rtc.example.test/",
        remoteTransportType: "livekit",
        remoteLivekitServiceUrl: "https://rtc.example.test",
      }),
    ).not.toThrow();
  });

  it.each([
    ["https://attacker.example.test", "livekit", "https://rtc.example.test"],
    ["https://rtc.example.test", "livekit", "https://attacker.example.test"],
    ["https://rtc.example.test", "other", "https://rtc.example.test"],
  ])("rejects an untrusted transport", (homeserverUrl, remoteType, remoteUrl) => {
    expect(() =>
      assertMatrixRtcPinnedTransports({
        pinnedAuthServiceUrl: "https://rtc.example.test",
        homeserverLivekitServiceUrl: homeserverUrl,
        remoteTransportType: remoteType,
        remoteLivekitServiceUrl: remoteUrl,
      }),
    ).toThrow(/pinned|untrusted/);
  });
});

describe("assertMatrixRtcEncryptionCompatibility", () => {
  it("accepts the explicit per-member encryption descriptor", () => {
    expect(() =>
      assertMatrixRtcEncryptionCompatibility(RTC_SLOT_ENCRYPTION_PER_MEMBER),
    ).not.toThrow();
  });

  it("accepts an omitted optional descriptor for dynamic key verification", () => {
    expect(() => assertMatrixRtcEncryptionCompatibility(undefined)).not.toThrow();
  });

  it("rejects an explicitly unsupported encryption scheme", () => {
    expect(() => assertMatrixRtcEncryptionCompatibility("example.clear-media")).toThrow(
      "unsupported media encryption scheme",
    );
  });
});
