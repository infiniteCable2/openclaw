import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { convertToLlm, type CustomMessage } from "../sessions/messages.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { textAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { prepareCompactionBudgetPreflight } from "./compaction-budget-preflight.js";
import { shouldPreemptivelyCompactBeforePrompt } from "./run/preemptive-compaction.js";

const budget = { contextTokenBudget: 20_000, reserveTokens: 2_000, prompt: "Continue." };

function completedHistory(imageBytes: number): AgentMessage[] {
  const imageCount = 64;
  const image = {
    type: "image" as const,
    data: "A".repeat(Math.ceil(imageBytes / imageCount)),
    mimeType: "image/png",
  };
  const messages: AgentMessage[] = [
    {
      role: "user",
      content: Array.from({ length: imageCount }, () => ({ ...image })),
      timestamp: 0,
    },
    castAgentMessage(textAssistant("The image shows a room.")),
  ];
  for (let turn = 0; turn < 5; turn++) {
    messages.push(
      { role: "user", content: "A brief follow-up.", timestamp: turn + 1 },
      castAgentMessage(textAssistant("Understood.")),
    );
  }
  return messages;
}

describe("prepared compaction budget preflight", () => {
  it("counts actual prospective quoted messages through native conversion without changing durable history", () => {
    const history: AgentMessage[] = [{ role: "user", content: "Existing request.", timestamp: 1 }];
    const pending: CustomMessage[] = [
      {
        role: "custom",
        customType: "openclaw.test-observation",
        content: "Quoted observation. ".repeat(8_000),
        display: false,
        timestamp: 2,
      },
    ];
    const before = structuredClone({ history, pending });
    const actual = prepareCompactionBudgetPreflight({
      ...budget,
      messages: history,
      pendingMessages: pending,
    });
    expect(actual).toEqual(
      shouldPreemptivelyCompactBeforePrompt({
        ...budget,
        messages: [...history, ...convertToLlm(pending)],
      }),
    );
    expect(actual.shouldCompact).toBe(true);
    expect(prepareCompactionBudgetPreflight({ ...budget, messages: history }).shouldCompact).toBe(
      false,
    );
    expect({ history, pending }).toEqual(before);
  });

  it("keeps prospective images unprocessed while pruning only durable old images", () => {
    const history = completedHistory(3_100_000);
    const pending: CustomMessage[] = [
      {
        role: "custom",
        customType: "openclaw.test-observation",
        content: Array.from({ length: 64 }, () => ({
          type: "image" as const,
          mimeType: "image/png",
          data: "A",
        })),
        display: false,
        timestamp: 10,
      },
    ];
    expect(prepareCompactionBudgetPreflight({ ...budget, messages: history }).shouldCompact).toBe(
      false,
    );
    expect(
      prepareCompactionBudgetPreflight({ ...budget, messages: history, pendingMessages: pending })
        .shouldCompact,
    ).toBe(true);
    expect(history).toHaveLength(12);
  });

  it("does not mistake old image payload bytes for token pressure or mutate history", () => {
    const messages = completedHistory(3_100_000);
    const originalImage = messages[0];
    const result = prepareCompactionBudgetPreflight({ ...budget, messages });
    expect(result.route).toBe("fits");
    expect(result.shouldCompact).toBe(false);
    expect(messages[0]).toBe(originalImage);
    if (originalImage?.role !== "user" || !Array.isArray(originalImage.content)) {
      throw new Error("Expected the original image turn");
    }
    expect(originalImage.content).toHaveLength(64);
    expect(
      originalImage.content.every(
        (block) => block.type === "image" && block.data.length === 48_438,
      ),
    ).toBe(true);
  });

  it("still charges unprocessed recent images against the native token budget", () => {
    const messages = completedHistory(3_100_000);
    const imageTurn = messages[0]!;
    const result = prepareCompactionBudgetPreflight({
      ...budget,
      messages: [...messages, imageTurn],
    });
    expect(result.shouldCompact).toBe(true);
  });

  it.each(["history", "prompt", "system", "tools"])(
    "uses native token pressure for actual %s growth",
    (source) => {
      const messages: AgentMessage[] =
        source === "history"
          ? [{ role: "user", content: "meaningful source text ".repeat(20_000), timestamp: 1 }]
          : [];
      const result = prepareCompactionBudgetPreflight({
        ...budget,
        messages,
        ...(source === "prompt" ? { prompt: "pending input ".repeat(20_000) } : {}),
        ...(source === "system" ? { systemPrompt: "system instruction ".repeat(20_000) } : {}),
        ...(source === "tools" ? { toolSchemaTokens: 30_000 } : {}),
      });
      expect(result.shouldCompact).toBe(true);
      expect(result.route).toBe("compact_only");
    },
  );
});
