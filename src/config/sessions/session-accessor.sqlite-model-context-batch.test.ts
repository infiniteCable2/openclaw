import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  persistSessionTranscriptTurn,
} from "./session-accessor.js";
import { withBoundedContextScope } from "./session-accessor.sqlite-bounded-context.test-support.js";
import {
  readSessionTranscriptModelContext,
  readSessionTranscriptModelContexts,
  type SessionTranscriptModelContextRange,
  type SessionTranscriptModelContextRangeResult,
} from "./session-accessor.sqlite-model-context.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import { readSessionTranscriptModelContextsAsync } from "./session-transcript-context-read.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence.js";
import * as transcriptReadSource from "./session-transcript-read-source.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

function individual(
  scope: Parameters<typeof readSessionTranscriptModelContext>[0],
  range: SessionTranscriptModelContextRange,
): SessionTranscriptModelContextRangeResult {
  try {
    return {
      ok: true,
      context: readSessionTranscriptModelContext(scope, range.through, range.limits),
    };
  } catch (error) {
    if (!(error instanceof SessionTranscriptReadFenceError) && !(error instanceof RangeError)) {
      throw error;
    }
    return {
      ok: false,
      reason:
        error instanceof RangeError ? "source-range-over-capacity" : "source-range-unverified",
    };
  }
}

it("rejects process-held batch scheduling overflow before opening its source or consuming data", async () => {
  const target = {
    agentId: "main",
    sessionId: "synthetic-source",
    sessionKey: "agent:main:dashboard:incognito-synthetic",
    storePath: "/synthetic/agent.sqlite",
  };
  const through = {
    ...target,
    generation: "synthetic-generation",
    entryId: "synthetic-entry",
    rawSeq: 1,
    effectiveParentId: null,
    activeMessagePosition: 0,
  };
  const range = { through, limits: { maxBytes: 64 * 1024 * 1024, maxEvents: 10_000 } };
  const dispatch = vi
    .spyOn(transcriptReadSource, "withSessionTranscriptReadSource")
    .mockImplementation(async () => {
      throw new Error("An overflowing batch must not open a source");
    });
  const consume = vi.fn();
  try {
    for (const ranges of [
      [range, range, range],
      [range, { ...range, limits: { ...range.limits, maxBytes: range.limits.maxBytes + 1 } }],
    ]) {
      await expect(
        readSessionTranscriptModelContextsAsync(target, ranges, consume),
      ).rejects.toThrow("Model-context batch exceeds its scheduling budget");
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  } finally {
    dispatch.mockRestore();
  }
});

it("reads overlapping long-source navigation once while preserving exact range output", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: Array.from({ length: 600 }, (_, index) =>
        transcriptMessage(`entry-${index}`, index ? `entry-${index - 1}` : null, {
          role: "user",
          content: `Synthetic observation ${index}.`,
          timestamp: index + 1,
        }),
      ),
      touchSessionEntry: false,
    });
    await waitForSessionTranscriptProjection(scope);
    const ranges = [598, 599].map((index) => {
      const through = readActiveTranscriptEntryAnchor({ ...scope, entryId: `entry-${index}` });
      if (!through) {
        throw new Error("Synthetic range anchor missing");
      }
      return { through, limits: { from: through, maxBytes: 2_048, maxEvents: 1 } };
    });
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const counter = trackSqliteStatementExecutions(db, ["navigation"], (sql) =>
      sql.includes('as "navigation_json" from "transcript_events"') ? "navigation" : null,
    );
    try {
      const expected = ranges.map((range) => individual(scope, range));
      expect(counter.counts.navigation).toBe(2);
      const beforeRows = counter.rowCounts.navigation;
      const actual = readSessionTranscriptModelContexts(scope, ranges);
      expect(actual).toEqual(expected);
      expect(actual.every((result) => result.ok)).toBe(true);
      expect(counter.counts.navigation).toBe(3);
      const batchRows = counter.rowCounts.navigation - beforeRows;
      expect(batchRows).toBeGreaterThanOrEqual(600);
      expect(batchRows).toBeLessThan(beforeRows);
    } finally {
      counter.restore();
    }
  });
});

it("keeps historical prefixes independent of later opaque controls and reset boundaries", async () => {
  await withBoundedContextScope(async (scope) => {
    await appendTranscriptMessage(scope, {
      eventId: "early-question",
      message: { role: "user", content: "Earlier question.", timestamp: 1 },
    });
    await appendTranscriptMessage(scope, {
      eventId: "early-answer",
      message: { role: "assistant", content: "Earlier answer.", timestamp: 2 },
    });
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "opaque-leaf",
      parentId: "early-answer",
      targetId: "early-answer",
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "opaque-leaf",
      firstKeptEntryId: "early-question",
      summary: "New boundary.",
    });
    await appendTranscriptMessage(scope, {
      eventId: "late-question",
      message: { role: "user", content: "Later question.", timestamp: 3 },
    });
    await waitForSessionTranscriptProjection(scope);
    const early = readActiveTranscriptEntryAnchor({ ...scope, entryId: "early-answer" });
    const late = readActiveTranscriptEntryAnchor({ ...scope, entryId: "late-question" });
    if (!early || !late) {
      throw new Error("Synthetic prefix anchors missing");
    }
    const ranges = [late, early].map((through) => ({
      through,
      limits: { maxBytes: 16_384, maxEvents: 10 },
    }));
    const expected = ranges.map((range) => individual(scope, range));
    expect(readSessionTranscriptModelContexts(scope, ranges)).toEqual(expected);
    expect(expected[1]?.ok && JSON.stringify(expected[1].context.events)).not.toContain(
      "Later question",
    );
    expect(expected[1]?.ok && JSON.stringify(expected[1].context.events)).not.toContain(
      "reset-boundary",
    );
    expect(await readSessionTranscriptModelContextsAsync(scope, ranges, (value) => value)).toEqual(
      expected,
    );
  });
});

it("isolates invalid and over-capacity ranges without acknowledging or suppressing a valid sibling", async () => {
  await withBoundedContextScope(async (scope) => {
    await appendTranscriptMessage(scope, {
      eventId: "large-message",
      message: { role: "user", content: "x".repeat(8_000), timestamp: 1 },
    });
    await appendTranscriptMessage(scope, {
      eventId: "small-message",
      message: { role: "user", content: "A small observation.", timestamp: 2 },
    });
    await waitForSessionTranscriptProjection(scope);
    const large = readActiveTranscriptEntryAnchor({ ...scope, entryId: "large-message" });
    const small = readActiveTranscriptEntryAnchor({ ...scope, entryId: "small-message" });
    if (!large || !small) {
      throw new Error("Synthetic capacity anchors missing");
    }
    const valid = { through: small, limits: { from: small, maxBytes: 2_048, maxEvents: 1 } };
    for (const invalid of [
      {
        through: { ...large, generation: "not-the-source-generation" },
        limits: { from: large, maxBytes: 16_384, maxEvents: 10 },
      },
      { through: large, limits: { from: small, maxBytes: 16_384, maxEvents: 10 } },
      { through: large, limits: { from: large, maxBytes: 128, maxEvents: 1 } },
    ]) {
      const ranges = [invalid, valid];
      const expected = ranges.map((range) => individual(scope, range));
      expect(expected[0]?.ok).toBe(false);
      expect(expected[1]?.ok).toBe(true);
      expect(readSessionTranscriptModelContexts(scope, ranges)).toEqual(expected);
      expect(
        await readSessionTranscriptModelContextsAsync(scope, ranges, (value) => value),
      ).toEqual(expected);
    }
    expect(() => readSessionTranscriptModelContexts(scope, [valid, valid, valid])).toThrow(
      "scheduling budget",
    );
    expect(readSessionTranscriptModelContext(scope, small, valid.limits).events).not.toEqual([]);
  });
});
