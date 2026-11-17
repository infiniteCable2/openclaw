import type { OpenClawConfig } from "../config/types.openclaw.js";

export function greetingEventsFor(text: string) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [],
        model: "fixture",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...Array.from(text, (part) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: part },
    })),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
}

export function greetingConfiguration(baseUrl: string, workspace: string): OpenClawConfig {
  return {
    gateway: { mode: "local" },
    agents: {
      entries: { main: { workspace, identity: { language: "de" } } },
      defaults: {
        workspace,
        model: { primary: "fixture/fixture", fallbacks: [] },
        modelPolicy: { allow: ["fixture/fixture"] },
        models: { "fixture/fixture": { agentRuntime: { id: "openclaw" } } },
        utilityModel: "",
        skills: [],
        thinkingDefault: "medium",
      },
    },
    models: {
      mode: "replace",
      providers: {
        fixture: {
          baseUrl,
          api: "anthropic-messages",
          apiKey: "synthetic-fixture-key",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: true,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    plugins: { slots: { memory: "none" } },
    skills: { load: { watch: false } },
  };
}
