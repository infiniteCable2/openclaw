import { expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { loadTranscriptEvents, persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readSessionTranscriptBoundedActiveContextCore,
  readSessionTranscriptBoundedActiveContextUsageCore,
} from "./session-accessor.sqlite-active-context.js";
import {
  countAcquiredTranscriptPayloadBytes,
  withBoundedContextScope,
} from "./session-accessor.sqlite-bounded-context.test-support.js";
import { appendSessionTranscriptReportBatch } from "./session-accessor.sqlite-transcript-reports.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

it("sizes bounded context without acquiring message payloads, including header and cutoff budgets", async () => {
  await withBoundedContextScope(async (scope) => {
    const marker = "synthetic-context-sizing-payload:";
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("old", null, { role: "user", content: marker + "x".repeat(8192) }),
        transcriptMessage("new", "old", { role: "assistant", content: marker }),
      ],
      touchSessionEntry: false,
    });
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const full = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 16_384,
      maxEvents: 10,
    });
    const headerBytes = Buffer.byteLength(JSON.stringify(full.events[0])) + 1;
    for (const limits of [
      { maxBytes: 16_384, maxEvents: 10 },
      { maxBytes: 16_384, maxEvents: 1 },
      { maxBytes: 1024, maxEvents: 10 },
      { maxBytes: headerBytes, maxEvents: 10 },
    ]) {
      const context = readSessionTranscriptBoundedActiveContextCore(scope, limits);
      const acquiredBytes = countAcquiredTranscriptPayloadBytes(db, marker, () => {
        expect(readSessionTranscriptBoundedActiveContextUsageCore(scope, limits)).toEqual({
          eventCount: context.events.length,
          serializedBytes: context.serializedBytes,
          truncated: context.truncated,
        });
      });
      expect(acquiredBytes).toBe(0);
    }
    expect(() =>
      readSessionTranscriptBoundedActiveContextUsageCore(scope, {
        maxBytes: headerBytes - 1,
        maxEvents: 10,
      }),
    ).toThrow(RangeError);
  });
});

it("admits reports after native compaction without charging summarized ancestors", async () => {
  await withBoundedContextScope(async (scope) => {
    await captureRuntimeConfigAsyncReader()();
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("archived", null, {
          role: "user",
          content: "Archived original " + "x".repeat(2_400),
        }),
        transcriptMessage("retained", "archived", {
          role: "assistant",
          content: "Retained answer",
        }),
      ],
      touchSessionEntry: false,
    });
    const originalHistory = await loadTranscriptEvents(scope);
    const limits = { maxBytes: 4_096, maxEvents: 100 };
    const report = (id: string, size: number) => ({
      report: {
        customType: "synthetic-compaction-observation",
        content: "New observation " + "y".repeat(size),
        display: false,
        details: { packetId: id },
      },
      receipt: { field: "packetId", value: id },
    });
    const pending = report("pending", 1_600);
    const options = { contextAdmission: { limits, onDeferred: () => {} } };
    expect(await appendSessionTranscriptReportBatch(scope, [pending], options)).toEqual({
      ok: true,
      value: { accepted: 0, appended: 0, deferred: true },
    });
    expect(await loadTranscriptEvents(scope)).toEqual(originalHistory);
    const manager = await SessionManager.openAsync(scope);
    await manager.appendCompactionAsync("The archived original was summarized.", "retained", 1_000);
    const compactedHistory = await loadTranscriptEvents(scope);
    expect(compactedHistory.slice(0, originalHistory.length)).toEqual(originalHistory);
    expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("x".repeat(2_400));
    // The byte ceiling is unchanged: only the native semantic window became smaller.
    expect(await appendSessionTranscriptReportBatch(scope, [pending], options)).toEqual({
      ok: true,
      value: { accepted: 1, appended: 1, deferred: false },
    });
    const admittedHistory = await loadTranscriptEvents(scope);
    expect(admittedHistory.slice(0, compactedHistory.length)).toEqual(compactedHistory);
    expect(
      await appendSessionTranscriptReportBatch(scope, [report("oversized", 4_096)], options),
    ).toEqual({
      ok: true,
      value: { accepted: 0, appended: 0, deferred: true },
    });
    expect(await loadTranscriptEvents(scope)).toEqual(admittedHistory);
  });
});
