import path from "node:path";
import { describe, expect, it } from "vitest";
import { findMatrixRtcAdmission, resolveMatrixRtcConfig } from "./rtc-config.js";

const command = path.resolve("matrix-rtc-media");

function validConfig() {
  return {
    enabled: true as const,
    authServiceUrl: "https://rtc.example.org/livekit/jwt/",
    mediaBridgeCommand: command,
    transcriptionProvider: "local-media",
    admissions: [
      {
        roomId: "!private:example.org",
        userId: "@owner:example.org",
        agentId: "steffen",
      },
    ],
  };
}

describe("MatrixRTC config", () => {
  it("stays disabled unless explicitly enabled", () => {
    expect(resolveMatrixRtcConfig(undefined)).toBeNull();
    expect(resolveMatrixRtcConfig({ enabled: false })).toBeNull();
  });

  it("normalizes a strict admission and pinned authorization URL", () => {
    const resolved = resolveMatrixRtcConfig(validConfig());
    expect(resolved?.authServiceUrl).toBe("https://rtc.example.org/livekit/jwt");
    expect(findMatrixRtcAdmission(resolved!, "!private:example.org")?.agentId).toBe("steffen");
  });

  it.each([
    [{ ...validConfig(), mediaBridgeCommand: "relative/bin" }, "absolute path"],
    [{ ...validConfig(), authServiceUrl: "http://rtc.example.org" }, "must use HTTPS"],
    [{ ...validConfig(), admissions: [] }, "at least one exact admission"],
    [
      {
        ...validConfig(),
        admissions: [
          ...validConfig().admissions,
          { roomId: "!private:example.org", userId: "@other:example.org", agentId: "other" },
        ],
      },
      "more than one admission",
    ],
  ])("rejects unsafe enabled configuration", (config, message) => {
    expect(() => resolveMatrixRtcConfig(config)).toThrow(message);
  });
});
