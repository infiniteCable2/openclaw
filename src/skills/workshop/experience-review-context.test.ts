import { describe, expect, it } from "vitest";
import type { CompactionEntry } from "../../agents/sessions/session-manager-types.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { restoreExperienceReviewContextTail } from "./experience-review-context.js";

describe("experience review maintenance snapshot", () => {
  function fixture() {
    const historical = SessionManager.inMemory();
    const terminal = historical.appendMessage({ role: "user", content: "Evidence", timestamp: 1 });
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "summary",
      parentId: terminal,
      timestamp: new Date(1).toISOString(),
      summary: "Verified procedure",
      firstKeptEntryId: terminal,
      tokensBefore: 100,
    };
    return { historical, terminal, compaction };
  }

  it.each(["missing retained anchor", "wrong parent", "duplicate id", "empty summary"])(
    "refuses %s instead of resurrecting the pre-compaction context",
    (fault) => {
      const { historical, terminal, compaction } = fixture();
      if (fault === "missing retained anchor") {
        compaction.firstKeptEntryId = "missing";
      } else if (fault === "wrong parent") {
        compaction.parentId = "other-turn";
      } else if (fault === "duplicate id") {
        compaction.id = terminal;
      } else {
        compaction.summary = " ";
      }
      expect(() =>
        restoreExperienceReviewContextTail(historical, terminal, [compaction]),
      ).toThrow();
      expect(historical.buildSessionContext().messages).toHaveLength(1);
    },
  );

  it("refuses a later user turn disguised as maintenance", () => {
    const { historical, terminal, compaction } = fixture();
    expect(() =>
      restoreExperienceReviewContextTail(historical, terminal, [
        compaction,
        {
          type: "message",
          id: "later-turn",
          parentId: compaction.id,
          timestamp: new Date(2).toISOString(),
          message: { role: "user", content: "Later turn", timestamp: 2 },
        },
      ]),
    ).toThrow("source boundary");
  });

  it("keeps native summary-only compaction valid and leaves the original snapshot untouched", () => {
    const { historical, terminal, compaction } = fixture();
    compaction.firstKeptEntryId = compaction.id;
    const review = restoreExperienceReviewContextTail(historical, terminal, [compaction]);
    expect(review.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "Verified procedure" },
    ]);
    expect(historical.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "Evidence" },
    ]);
  });
});
