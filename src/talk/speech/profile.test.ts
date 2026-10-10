import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTalkSpeechAgentProfile } from "./profile.js";

describe("admitted-agent Talk speech policy", () => {
  const config: OpenClawConfig = {
    talk: {
      agentId: "writer",
      speech: {
        agentProfiles: {
          reader: {
            responseStreaming: "sentence",
            speakCommentary: true,
            waitingAudio: { filePath: "/tmp/wait.wav", startDelayMs: 0, volume: 0.2 },
            greeting: {
              enabled: true,
              prompt: "Hello briefly.",
              timeZone: "UTC",
              timeoutMs: 20000,
              onFailure: "continue",
            },
          },
          writer: { responseStreaming: "off", greeting: { enabled: false } },
        },
      },
    },
  };

  it("selects only the exact admitted agent's presentation policy", () => {
    expect(resolveTalkSpeechAgentProfile(config, "reader")).toEqual({
      responseStreaming: "sentence",
      speakCommentary: true,
      waitingAudio: { filePath: "/tmp/wait.wav", startDelayMs: 0, volume: 0.2 },
      greeting: {
        enabled: true,
        prompt: "Hello briefly.",
        timeZone: "UTC",
        timeoutMs: 20000,
        onFailure: "continue",
      },
    });
    expect(resolveTalkSpeechAgentProfile(config, "writer")).toEqual({
      responseStreaming: "off",
      speakCommentary: false,
    });
  });

  it.each(["unknown", "Reader", "reader ", "main", "constructor"])(
    "does not fall back through authored Talk ownership or aliases for %j",
    (agentId) => {
      expect(resolveTalkSpeechAgentProfile(config, agentId)).toEqual({
        responseStreaming: "sentence",
        speakCommentary: false,
      });
    },
  );

  it("does not resolve inherited profile keys", () => {
    const inherited: OpenClawConfig = {
      talk: {
        speech: {
          agentProfiles: Object.create({
            reader: { responseStreaming: "off", speakCommentary: true },
          }),
        },
      },
    };
    expect(resolveTalkSpeechAgentProfile(inherited, "reader")).toEqual({
      responseStreaming: "sentence",
      speakCommentary: false,
    });
  });

  it("supplies greeting preparation defaults only when explicitly enabled", () => {
    const result = resolveTalkSpeechAgentProfile(
      { talk: { speech: { agentProfiles: { reader: { greeting: { enabled: true } } } } } },
      "reader",
    );
    expect(result.greeting).toMatchObject({ enabled: true, timeoutMs: 30000, onFailure: "reject" });
    expect(result.greeting?.prompt).toContain("time of day");
    expect(result.greeting).not.toHaveProperty("timeZone");
    expect(resolveTalkSpeechAgentProfile({}, "reader")).not.toHaveProperty("greeting");
  });
});
