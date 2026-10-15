import { describe, expect, it } from "vitest";
import { TalkSchema } from "./zod-schema.root-support.js";
import { TalkSpeechSchema } from "./zod-schema.talk-speech.js";

describe("Talk speech profile admission", () => {
  it("admits independent channel/provider-bound agent execution controls", () => {
    const agentOverrides = {
      channels: {
        matrix: {
          providers: {
            ollama: { thinking: "off" },
            openai: { thinking: "low", fastMode: true },
            fixture: { fastMode: false },
          },
        },
      },
    };
    expect(
      TalkSchema.parse({ speech: { agentProfiles: { reader: { agentOverrides } } } }).speech
        ?.agentProfiles.reader?.agentOverrides,
    ).toEqual(agentOverrides);
  });

  it.each([
    { thinking: "invalid" },
    { thinking: false },
    { fastMode: "auto" },
    { fastMode: 1 },
    { thinking: "off", enabled: true },
    { model: "fixture/other" },
    { agentId: "writer" },
  ])("rejects invalid provider execution control %j", (overrides) => {
    expect(
      TalkSpeechSchema.safeParse({
        agentProfiles: {
          reader: {
            agentOverrides: { channels: { matrix: { providers: { fixture: overrides } } } },
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each(["", " matrix ", "__proto__", "constructor", "prototype"])(
    "rejects ambiguous or reserved override scope key %j",
    (id) => {
      for (const channels of [
        { [id]: { providers: { fixture: { thinking: "off" } } } },
        { matrix: { providers: { [id]: { thinking: "off" } } } },
      ]) {
        expect(
          TalkSpeechSchema.safeParse({
            agentProfiles: { reader: { agentOverrides: { channels } } },
          }).success,
        ).toBe(false);
      }
    },
  );

  it("keeps explicit prototype keys as admission errors rather than stripping them", () => {
    const speech = JSON.parse(
      '{"agentProfiles":{"reader":{"agentOverrides":{"channels":{"matrix":{"providers":{"__proto__":{"thinking":"off"}}}}}}}}',
    );
    const result = TalkSpeechSchema.safeParse(speech);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: [
            "agentProfiles",
            "reader",
            "agentOverrides",
            "channels",
            "matrix",
            "providers",
            "__proto__",
          ],
        }),
      );
    }
  });

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

  it("admits exact expression channel/target opt-ins without changing other presentation", () => {
    const profile = {
      expression: { channels: { matrix: { targets: ["audio-file", "telephony"] } } },
    };
    expect(
      TalkSpeechSchema.parse({ agentProfiles: { reader: profile } }).agentProfiles.reader,
    ).toEqual(profile);
  });

  const invalidExpressionPolicies = [
    { channels: { matrix: { targets: ["anything"] } } },
    { channels: { matrix: { targets: ["voice-note"], enabled: true } } },
    { channels: { " matrix ": { targets: ["voice-note"] } } },
    { channels: { constructor: { targets: ["voice-note"] } } },
    { enabled: true },
  ] as const;
  it.for(invalidExpressionPolicies)("rejects ambiguous expression policy %j", (expression) => {
    expect(TalkSpeechSchema.safeParse({ agentProfiles: { reader: { expression } } }).success).toBe(
      false,
    );
  });
});
