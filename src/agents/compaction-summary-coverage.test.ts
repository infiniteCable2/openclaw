import { describe, expect, it } from "vitest";
import {
  assertGeneratedCompactionSummary,
  requiresCompleteCompactionSummary,
  withCompleteCompactionSummary,
} from "./compaction-summary-coverage.js";

describe("native compaction summary coverage", () => {
  it("refuses no-summary fallbacks only during branch maintenance and releases on failure", async () => {
    expect(requiresCompleteCompactionSummary()).toBe(false);
    await expect(
      withCompleteCompactionSummary(async () => {
        await Promise.resolve();
        expect(requiresCompleteCompactionSummary()).toBe(true);
        assertGeneratedCompactionSummary();
      }),
    ).rejects.toThrow("requires a generated summary");
    expect(requiresCompleteCompactionSummary()).toBe(false);
    expect(() => assertGeneratedCompactionSummary()).not.toThrow();
  });
});
