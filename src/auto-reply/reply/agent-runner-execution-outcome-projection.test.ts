import { describe, expect, it } from "vitest";
import {
  buildAbortedAgentTurnExecutionResult,
  buildAgentTurnExecutionResult,
} from "./agent-runner-execution-outcome.js";

describe("native execution outcome projection", () => {
  it("preserves a rejected original answer and its post-compaction failure classification", () => {
    const payload = { text: "Original native failure" };
    expect(
      buildAgentTurnExecutionResult(
        "original-run",
        {
          kind: "final",
          payload,
          resolved: { provider: "example-provider", model: "example-model" },
          postCompactionModelFailure: true,
        },
        { count: 0, durable: [] },
      ),
    ).toEqual({
      runId: "original-run",
      outcome: {
        kind: "rejected",
        payload,
        resolved: { provider: "example-provider", model: "example-model" },
        postCompactionModelFailure: true,
      },
    });
  });

  it.each(["user", "restart", "superseded"] as const)(
    "keeps committed compaction accounting after %s cancellation without aliasing it",
    (reason) => {
      const compaction = { count: 1, durable: [] };
      const result = buildAbortedAgentTurnExecutionResult("original-run", reason, compaction);
      expect(result.outcome).toEqual({ kind: "aborted", reason, compaction });
      expect(result.outcome.compaction?.durable).not.toBe(compaction.durable);
      compaction.count = 2;
      expect(result.outcome.compaction?.count).toBe(1);
    },
  );
});
