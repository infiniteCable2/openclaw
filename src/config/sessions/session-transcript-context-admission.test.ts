import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendSessionTranscriptReport,
  loadTranscriptEvents,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import type { CustomMessageReport } from "./session-accessor.sqlite-transcript-reports.types.js";
import { readSessionTranscriptModelContextAsync } from "./session-transcript-context-read.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("atomic context-preserving custom report admission", () => {
  it.each(["bytes", "events", "fits"] as const)(
    "initializes an empty recipient atomically when the admission outcome is %s",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:empty-context-admission",
          sessionId: "empty-context-admission",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        expect(await loadTranscriptEvents(scope)).toEqual([]);
        const onDeferred = vi.fn();
        const onUpdate = vi.fn();
        onTestFinished(onInternalSessionTranscriptUpdate(onUpdate));
        const selectReport = vi.fn((latest: CustomMessageReport | undefined) =>
          latest
            ? undefined
            : {
                customType: "synthetic-knowledge",
                content: "First related observation. ".repeat(1_000),
                display: false,
                details: { packetId: "first-packet", offset: 0, complete: true },
              },
        );
        const report = {
          kind: "custom" as const,
          customTypes: ["synthetic-knowledge"],
          receipt: { field: "packetId", value: "first-packet" },
          selectReport,
        };
        const limits = {
          maxBytes: mode === "bytes" ? 4_096 : 100_000,
          maxEvents: mode === "events" ? 1 : 100,
        };
        expect(
          await appendSessionTranscriptReport(scope, report, {
            contextAdmission: { limits, onDeferred },
          }),
        ).toEqual({ ok: true, value: undefined });
        expect(selectReport).toHaveBeenCalledOnce();
        if (mode !== "fits") {
          expect(onDeferred).toHaveBeenCalledOnce();
          // Even the provisional header and its publication must roll back.
          expect(await loadTranscriptEvents(scope)).toEqual([]);
          expect(onUpdate).not.toHaveBeenCalled();
          expect(
            await appendSessionTranscriptReport(scope, report, {
              contextAdmission: {
                limits: { maxBytes: 100_000, maxEvents: 100 },
                onDeferred: () => {
                  throw new Error("An empty recipient with sufficient budget must admit");
                },
              },
            }),
          ).toEqual({ ok: true, value: undefined });
        } else {
          expect(onDeferred).not.toHaveBeenCalled();
        }
        const stored = await loadTranscriptEvents(scope);
        expect(stored).toEqual([
          expect.objectContaining({ type: "session", id: scope.sessionId }),
          expect.objectContaining({
            type: "custom_message",
            customType: "synthetic-knowledge",
            details: { packetId: "first-packet", offset: 0, complete: true },
          }),
        ]);
        const context = await readSessionTranscriptModelContextAsync(
          scope,
          (value) => value,
          undefined,
          undefined,
          undefined,
          { maxBytes: 100_000, maxEvents: 100 },
        );
        expect(context.events).toEqual(stored);
        await appendSessionTranscriptReport(scope, report);
        expect(await loadTranscriptEvents(scope)).toEqual(stored);
      });
    },
  );

  it.each(["bytes", "events", "fits"] as const)(
    "preserves the existing native window when the admission outcome is %s",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:context-admission",
          sessionId: "context-admission",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        await replaceTranscriptEvents(scope, [
          { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
          {
            type: "message",
            id: "request",
            parentId: null,
            message: { role: "user", content: "Keep this original request." },
          },
          {
            type: "compaction",
            id: "boundary",
            parentId: "request",
            firstKeptEntryId: "request",
            summary: "Keep the existing summary and its retained request.",
            tokensBefore: 1_000,
          },
        ]);
        const before = readSessionTranscriptBoundedActiveContextCore(scope, {
          maxBytes: 1_000_000,
          maxEvents: 100,
        });
        expect(
          before.events.some(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "type" in event &&
              event.type === "compaction",
          ),
        ).toBe(true);
        const limits = {
          maxBytes: before.serializedBytes + (mode === "bytes" ? 100 : 100_000),
          maxEvents: mode === "events" ? before.events.length : 100,
        };
        const baseline = readSessionTranscriptBoundedActiveContextCore(scope, limits);
        const storedBefore = await loadTranscriptEvents(scope);
        const onDeferred = vi.fn();
        const onUpdate = vi.fn();
        onTestFinished(onInternalSessionTranscriptUpdate(onUpdate));
        const selectReport = vi.fn(() => ({
          customType: "synthetic-knowledge",
          content: "Extra observations 🙂 ".repeat(100),
          display: false,
          details: { packetId: "new-packet", offset: 0, complete: true },
        }));
        const result = await appendSessionTranscriptReport(
          scope,
          {
            kind: "custom",
            customTypes: ["synthetic-knowledge"],
            receipt: { field: "packetId", value: "new-packet" },
            selectReport,
          },
          { contextAdmission: { limits, onDeferred } },
        );
        expect(result).toEqual({ ok: true, value: undefined });
        expect(selectReport).toHaveBeenCalledOnce();
        const after = readSessionTranscriptBoundedActiveContextCore(scope, limits);
        const storedAfter = await loadTranscriptEvents(scope);
        if (mode === "fits") {
          expect(onDeferred).not.toHaveBeenCalled();
          expect(storedAfter).toHaveLength(storedBefore.length + 1);
          expect(storedAfter.slice(0, -1)).toEqual(storedBefore);
          expect(after.events.slice(0, baseline.events.length)).toEqual(baseline.events);
          expect(storedAfter.at(-1)).toMatchObject({
            type: "custom_message",
            details: { packetId: "new-packet" },
          });
          expect(JSON.stringify(storedAfter.at(-1))).not.toContain("preserveContextLimits");
        } else {
          expect(onDeferred).toHaveBeenCalledOnce();
          expect(storedAfter).toEqual(storedBefore);
          expect(after).toEqual(baseline);
          expect(onUpdate).not.toHaveBeenCalled();
        }
      });
    },
  );
});
