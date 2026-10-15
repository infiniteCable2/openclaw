import { describe, expect, it } from "vitest";
import {
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";

describe("Anthropic-compatible request thinking parity", () => {
  registerParityHostLifecycle();

  it.each([
    { reasoning: "off", thinking: { type: "disabled" } },
    { reasoning: "low", thinking: { type: "enabled", budget_tokens: 2048 } },
    { reasoning: "medium", thinking: { type: "enabled", budget_tokens: 8192 } },
  ] as const)("sends explicit $reasoning through both request builders", async (testCase) => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model: {
          provider: "ollama-anthropic",
          id: "test-reasoner",
          baseUrl: "https://ollama.example/v1",
          reasoning: true,
          maxTokens: 16384,
        },
        reasoning: testCase.reasoning,
      });
      expect(payload.thinking).toEqual({
        ...testCase.thinking,
        ...(implementation === "provider" && testCase.reasoning !== "off"
          ? { display: "summarized" }
          : {}),
      });
      expect(payload.tools).toEqual([
        expect.objectContaining({ name: "lookup", description: "Look up a value." }),
      ]);
      expect(payload).not.toHaveProperty("think");
      expect(payload).not.toHaveProperty("options");
      expect(payload).not.toHaveProperty("output_config");
    }
  });

  it("keeps real Anthropic off free of Ollama-only parameters", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model: { id: "claude-sonnet-4-5" },
        reasoning: "off",
      });
      expect(payload.thinking).toEqual({ type: "disabled" });
      expect(payload).not.toHaveProperty("think");
      expect(payload).not.toHaveProperty("options");
    }
  });

  it("does not advertise thinking to a non-reasoning custom model", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model: {
          provider: "ollama-anthropic",
          id: "test-model",
          baseUrl: "https://ollama.example/v1",
          reasoning: false,
        },
        reasoning: "off",
      });
      expect(payload).not.toHaveProperty("thinking");
      expect(payload).not.toHaveProperty("think");
    }
  });
});
