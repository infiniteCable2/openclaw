import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTalkSpeechAgentOverrides } from "./agent-overrides.js";

const config: OpenClawConfig = {
  talk: {
    speech: {
      agentProfiles: {
        reader: {
          agentOverrides: {
            channels: {
              matrix: {
                providers: {
                  "ollama-anthropic": { thinking: "off" },
                  ollama: { thinking: "off" },
                  openai: { thinking: "low", fastMode: true },
                  fixture: { fastMode: false },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("provider-bound speech agent overrides", () => {
  it.each([
    ["ollama-anthropic", { thinking: "off" }],
    ["ollama", { thinking: "off" }],
    ["openai", { thinking: "low", fastMode: true }],
    ["fixture", { fastMode: false }],
  ] as const)("selects only the actual provider %s", (provider, expected) => {
    expect(
      resolveTalkSpeechAgentOverrides({ config, agentId: "reader", channelId: "matrix", provider }),
    ).toEqual(expected);
  });

  it.each([
    { agentId: "writer", channelId: "matrix", provider: "ollama" },
    { agentId: "main", channelId: "matrix", provider: "ollama" },
    { agentId: "reader", channelId: "voiceassistant", provider: "ollama" },
    { agentId: "reader", channelId: "matrix", provider: "another-provider" },
    { agentId: "Reader", channelId: "matrix", provider: "ollama" },
    { agentId: "reader ", channelId: "matrix", provider: "ollama" },
    { agentId: "reader", channelId: " matrix", provider: "ollama" },
    { agentId: "reader", channelId: "matrix", provider: "ollama " },
    { agentId: "constructor", channelId: "matrix", provider: "ollama" },
    { agentId: "reader", channelId: "prototype", provider: "ollama" },
    { agentId: "reader", channelId: "matrix", provider: "__proto__" },
  ])("does not inherit or normalize another scope %j", (scope) => {
    expect(resolveTalkSpeechAgentOverrides({ config, ...scope })).toBeUndefined();
  });

  it("does not inherit provider or channel record entries", () => {
    const inherited: OpenClawConfig = {
      talk: {
        speech: {
          agentProfiles: {
            reader: {
              agentOverrides: {
                channels: {
                  matrix: { providers: Object.create({ ollama: { thinking: "high" } }) },
                },
              },
            },
            writer: {
              agentOverrides: {
                channels: Object.create({
                  matrix: { providers: { ollama: { thinking: "high" } } },
                }),
              },
            },
          },
        },
      },
    };
    for (const agentId of ["reader", "writer"]) {
      expect(
        resolveTalkSpeechAgentOverrides({
          config: inherited,
          agentId,
          channelId: "matrix",
          provider: "ollama",
        }),
      ).toBeUndefined();
    }
  });

  it("returns a new projection and leaves ordinary native defaults untouched", () => {
    const resolved = resolveTalkSpeechAgentOverrides({
      config,
      agentId: "reader",
      channelId: "matrix",
      provider: "openai",
    });
    expect(resolved).toEqual({ thinking: "low", fastMode: true });
    resolved!.thinking = "high";
    expect(
      resolveTalkSpeechAgentOverrides({
        config,
        agentId: "reader",
        channelId: "matrix",
        provider: "openai",
      }),
    ).toEqual({ thinking: "low", fastMode: true });
    expect(
      resolveTalkSpeechAgentOverrides({
        config: {},
        agentId: "reader",
        channelId: "matrix",
        provider: "openai",
      }),
    ).toBeUndefined();
  });
});
