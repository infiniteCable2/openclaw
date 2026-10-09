import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findMatrixRtcAdmission,
  resolveMatrixRtcAgentProfile,
  resolveMatrixRtcConfig,
} from "./rtc-config.js";

const command = path.resolve("matrix-rtc-media");
const waitingAudioPath = path.resolve("waiting.wav");

function validConfig() {
  return {
    enabled: true as const,
    authServiceUrl: "https://rtc.example.org/livekit/jwt/",
    mediaBridgeCommand: command,
    transcriptionProvider: "local-media",
    responseStreaming: "sentence" as const,
    agentProfiles: { example_owner: { agentThinkingLevel: "off" as const } },
    waitingAudio: { path: waitingAudioPath },
    admissions: [
      {
        roomId: "!private:example.org",
        userId: "@owner:example.org",
        agentId: "example_owner",
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
    const resolved = resolveMatrixRtcConfig({
      ...validConfig(),
      agentProfiles: { example_owner: { agentThinkingLevel: "off", speakCommentary: true } },
    });
    expect(resolved?.authServiceUrl).toBe("https://rtc.example.org/livekit/jwt");
    expect(findMatrixRtcAdmission(resolved!, "!private:example.org")?.agentId).toBe(
      "example_owner",
    );
    expect(resolved?.responseStreaming).toBe("sentence");
    expect(resolveMatrixRtcAgentProfile(resolved!, "example_owner")).toEqual({
      agentThinkingLevel: "off",
      speakCommentary: true,
    });
    expect(resolved?.waitingAudio).toEqual({
      filePath: waitingAudioPath,
      startDelayMs: 1_200,
      resumeDelayMs: 800,
      volume: 0.14,
    });
  });

  it("keeps agent speech streaming disabled unless explicitly selected", () => {
    const config = validConfig();
    const resolved = resolveMatrixRtcConfig({ ...config, responseStreaming: undefined });
    expect(resolved?.responseStreaming).toBe("off");
  });

  it("inherits agent thinking when the call override is absent", () => {
    const resolved = resolveMatrixRtcConfig({ ...validConfig(), agentProfiles: undefined });
    expect(
      resolveMatrixRtcAgentProfile(resolved!, "example_owner").agentThinkingLevel,
    ).toBeUndefined();
  });

  it("uses the admitted agent's call profile without applying it to other agents", () => {
    const resolved = resolveMatrixRtcConfig({
      ...validConfig(),
      agentProfiles: {
        example_owner: { agentThinkingLevel: "off", speakCommentary: true },
        example_other: { agentThinkingLevel: "low", speakCommentary: false },
      },
    })!;
    expect(resolveMatrixRtcAgentProfile(resolved, "example_owner")).toEqual({
      agentThinkingLevel: "off",
      speakCommentary: true,
    });
    expect(resolveMatrixRtcAgentProfile(resolved, "example_other")).toEqual({
      agentThinkingLevel: "low",
      speakCommentary: false,
    });
    expect(resolveMatrixRtcAgentProfile(resolved, "other")).toEqual({
      agentThinkingLevel: undefined,
      speakCommentary: false,
    });
  });

  it("allows future agents to have greetings without granting them call admission", () => {
    const greeting = {
      enabled: true as const,
      prompt: "Kurze Begrüßung persönlich und tageszeitgemäß.",
      timeZone: "Europe/Berlin",
    };
    const resolved = resolveMatrixRtcConfig({
      ...validConfig(),
      agentProfiles: {
        primary: { greeting },
        futureA: { greeting },
        futureB: { greeting },
      },
    })!;
    expect(resolveMatrixRtcAgentProfile(resolved, "primary").greeting).toEqual(greeting);
    expect(resolveMatrixRtcAgentProfile(resolved, "futureA").greeting).toEqual(greeting);
    expect(resolveMatrixRtcAgentProfile(resolved, "futureB").greeting).toEqual(greeting);
    expect(resolved.admissions).toHaveLength(1);
    expect(findMatrixRtcAdmission(resolved, "!unadmitted:example.org")).toBeUndefined();
  });

  it("keeps spoken commentary off by default and requires sentence streaming when enabled", () => {
    expect(
      resolveMatrixRtcAgentProfile(resolveMatrixRtcConfig(validConfig())!, "example_owner")
        .speakCommentary,
    ).toBe(false);
    expect(() =>
      resolveMatrixRtcConfig({
        ...validConfig(),
        agentProfiles: { example_owner: { speakCommentary: true } },
        responseStreaming: "off",
      }),
    ).toThrow("speakCommentary requires responseStreaming: sentence");
  });

  it.each([
    [{ ...validConfig(), mediaBridgeCommand: "relative/bin" }, "absolute path"],
    [
      { ...validConfig(), waitingAudio: { path: "relative/waiting.wav" } },
      "waitingAudio.path must be an absolute path",
    ],
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
