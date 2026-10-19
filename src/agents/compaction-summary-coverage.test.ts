import { describe, expect, it, vi } from "vitest";
import {
  reportCompactionSummaryLosses,
  requiresCompleteCompactionSummary,
  withCompleteCompactionSummary,
} from "./compaction-summary-coverage.js";

describe("native compaction summary coverage", () => {
  it("refuses known loss only inside its scoped complete catch-up and releases on failure", async () => {
    const warn = vi.fn();
    expect(requiresCompleteCompactionSummary()).toBe(false);
    await expect(
      withCompleteCompactionSummary(async () => {
        await Promise.resolve();
        expect(requiresCompleteCompactionSummary()).toBe(true);
        reportCompactionSummaryLosses(new Set(), warn);
        reportCompactionSummaryLosses(new Set(["summary-tail"]), warn);
      }),
    ).rejects.toThrow("exceeds the finalized artifact budget");
    expect(warn).not.toHaveBeenCalled();
    expect(requiresCompleteCompactionSummary()).toBe(false);
    reportCompactionSummaryLosses(new Set(["summary-tail"]), warn);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("loss=summary-tail"));
  });
});
