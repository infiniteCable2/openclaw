import { describe, expect, it } from "vitest";
import { TalkSchema } from "./zod-schema.root-support.js";
import { TalkSpeechSchema } from "./zod-schema.talk-speech.js";

describe("Talk speech profile admission", () => {
  it("validates speech profiles at the native Talk configuration boundary", () => {
    expect(
      TalkSchema.safeParse({
        speech: {
          agentProfiles: {
            reader: { responseStreaming: "off", speakCommentary: true },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      TalkSchema.parse({
        speech: {
          agentProfiles: {
            reader: { responseStreaming: "sentence", speakCommentary: true },
          },
        },
      }).speech?.agentProfiles.reader?.speakCommentary,
    ).toBe(true);
  });
  it("accepts explicit streaming, commentary, waiting audio and greeting policy", () => {
    expect(
      TalkSpeechSchema.parse({
        agentProfiles: {
          reader: {
            responseStreaming: "sentence",
            speakCommentary: true,
            waitingAudio: {
              filePath: "/tmp/wait.wav",
              startDelayMs: 0,
              resumeDelayMs: 800,
              volume: 0.2,
            },
            greeting: {
              enabled: true,
              prompt: " Brief greeting. ",
              timeZone: " UTC ",
              timeoutMs: 30000,
              onFailure: "reject",
            },
          },
        },
      }).agentProfiles.reader?.greeting,
    ).toMatchObject({ prompt: "Brief greeting.", timeZone: "UTC" });
  });

  it.each([
    { speakCommentary: true },
    { responseStreaming: "off", speakCommentary: true },
    { responseStreaming: "token" },
    { waitingAudio: { filePath: "/tmp/wait.wav", startDelayMs: -1, volume: 0.2 } },
    { waitingAudio: { filePath: "/tmp/wait.wav", startDelayMs: 0, volume: 1.1 } },
    { greeting: { enabled: true, prompt: " " } },
    { greeting: { timeoutMs: 0 } },
    { greeting: { onFailure: "ignore" } },
    { thinkLevel: "low" },
    { fastMode: true },
    { agentId: "writer" },
  ])("rejects invalid or unauthorized policy fields %j", (profile) => {
    expect(TalkSpeechSchema.safeParse({ agentProfiles: { reader: profile } }).success).toBe(false);
  });

  it.each([" reader ", "", "__proto__", "constructor", "prototype"])(
    "rejects ambiguous or reserved profile key %j",
    (id) => {
      expect(TalkSpeechSchema.safeParse({ agentProfiles: { [id]: {} } }).success).toBe(false);
      expect(TalkSchema.safeParse({ speech: { agentProfiles: { [id]: {} } } }).success).toBe(false);
    },
  );

  it("rejects a JSON-owned prototype key without silently removing it", () => {
    const speech = JSON.parse('{"agentProfiles":{"__proto__":{},"reader":{}}}');
    const result = TalkSchema.safeParse({ speech });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["speech", "agentProfiles", "__proto__"] }),
        ]),
      );
    }
  });
});
