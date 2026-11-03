import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTalkSpeechAgentProfile } from "./profile.js";

describe("admitted-agent Talk speech policy", () => {
  it("keeps provider execution overrides out of the presentation projection", () => {
    expect(
      resolveTalkSpeechAgentProfile(
        {
          talk: {
            speech: {
              agentProfiles: {
                reader: {
                  responseStreaming: "sentence",
                  agentOverrides: {
                    channels: { matrix: { providers: { fixture: { thinking: "off" } } } },
                  },
                },
              },
            },
          },
        },
        "reader",
      ),
    ).toEqual({
      responseStreaming: "sentence",
      speakCommentary: false,
      echoSuppressionTailSeconds: 3,
      inputEndMode: "server",
    });
  });

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
      echoSuppressionTailSeconds: 3,
      inputEndMode: "server",
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
      echoSuppressionTailSeconds: 3,
      inputEndMode: "server",
    });
  });

  it.each(["unknown", "Reader", "reader ", "main", "constructor"])(
    "does not fall back through authored Talk ownership or aliases for %j",
    (agentId) => {
      expect(resolveTalkSpeechAgentProfile(config, agentId)).toEqual({
        responseStreaming: "sentence",
        speakCommentary: false,
        echoSuppressionTailSeconds: 3,
        inputEndMode: "server",
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
      echoSuppressionTailSeconds: 3,
      inputEndMode: "server",
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

  it("uses only an exact verified source override and preserves zero", () => {
    const source = { channelId: "gateway", accountId: "paired-device", senderId: "device-a" };
    const configured: OpenClawConfig = {
      talk: {
        speech: {
          agentProfiles: {
            reader: {
              echoSuppressionTailSeconds: 1.25,
              sourceOverrides: [{ source, echoSuppressionTailSeconds: 0, inputEndMode: "client" }],
            },
          },
        },
      },
    };
    expect(
      resolveTalkSpeechAgentProfile(configured, "reader", source).echoSuppressionTailSeconds,
    ).toBe(0);
    expect(resolveTalkSpeechAgentProfile(configured, "reader", source).inputEndMode).toBe("client");
    for (const other of [
      undefined,
      { ...source, channelId: "webchat" },
      { ...source, accountId: "other-account" },
      { ...source, senderId: "device-b" },
      { ...source, senderId: "Device-a" },
    ]) {
      expect(resolveTalkSpeechAgentProfile(configured, "reader", other).inputEndMode).toBe(
        "server",
      );
      expect(
        resolveTalkSpeechAgentProfile(configured, "reader", other).echoSuppressionTailSeconds,
      ).toBe(1.25);
    }
    expect(
      resolveTalkSpeechAgentProfile(configured, "writer", source).echoSuppressionTailSeconds,
    ).toBe(3);
    expect(
      resolveTalkSpeechAgentProfile(
        { talk: { speech: { agentProfiles: { reader: { echoSuppressionTailSeconds: 0 } } } } },
        "reader",
      ).echoSuppressionTailSeconds,
    ).toBe(0);
  });
});
