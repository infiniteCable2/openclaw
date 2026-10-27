import { MessageChannel } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { withSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  appendSelectedTranscriptReportInTransaction,
  prepareCustomTranscriptReport,
  prepareTranscriptReportBatchSelection,
  reparentTranscriptReportBatchEntry,
} from "./session-accessor.sqlite-transcript-reports.kernel.js";
import type { PreparedTranscriptReportBatchEntry } from "./session-accessor.sqlite-transcript-reports.types.js";
import { bindSqliteWorkerBackend } from "./session-accessor.sqlite-transcript-reports.worker.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function prepared(id: string): PreparedTranscriptReportBatchEntry {
  const customType = "synthetic-cursor-observation";
  const receipt = { field: "packetId", value: id };
  return {
    ...prepareCustomTranscriptReport(
      {
        customType,
        content: `Exact prepared observation ${id}.`,
        display: false,
        details: { packetId: id },
      },
      null,
      { kind: "custom", customTypes: [customType], receipt },
    ),
    customType,
    receipt,
  };
}

function measure<T>(database: OpenClawAgentDatabase, run: () => T) {
  const counter = trackSqliteStatementExecutions(
    database.db,
    ["header", "window", "generation", "mutation"],
    (sql) => {
      if (/^select "seq" from "transcript_events".*\blimit\b/i.test(sql)) {
        return "header";
      }
      if (/^insert into "session_windows"/i.test(sql)) {
        return "window";
      }
      if (/^insert into "transcript_rewrite_watermarks"/i.test(sql)) {
        return "generation";
      }
      if (/^update "session_windows" set "transcript_updated_at"/i.test(sql)) {
        return "mutation";
      }
      return null;
    },
  );
  try {
    return { result: run(), counts: { ...counter.counts } };
  } finally {
    counter.restore();
  }
}

it.each([1, 32])(
  "reuses native batch initialization and one mutation for %i exact reports",
  async (count) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "report-cursor-scaling" },
      async (state) => {
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const scope = (name: string): ResolvedTranscriptScope => ({
          agentId: "main",
          sessionKey: `agent:main:cursor-${name}`,
          sessionId: `cursor-${name}`,
          path: database.path,
          env: state.env,
        });
        const legacy = scope("legacy"),
          batch = scope("batch");
        for (const target of [legacy, batch]) {
          await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
          await replaceTranscriptEvents(target, [
            { type: "session", id: target.sessionId, version: CURRENT_SESSION_VERSION },
            {
              type: "message",
              id: "current-user",
              parentId: null,
              message: { role: "user", content: "Current request", timestamp: 1 },
            },
          ]);
          await waitForSessionTranscriptProjection(target);
        }
        const reports = Array.from({ length: count }, (_, index) => prepared(`packet-${index}`));
        const before = readTranscriptContextVersionInTransaction(database, batch.sessionId);
        const baseline = measure(database, () =>
          runOpenClawAgentWriteTransaction(
            (current) => {
              let parent = prepareTranscriptReportBatchSelection(
                current,
                legacy,
                reports,
              ).appendParentId;
              for (const report of reports) {
                const selected = reparentTranscriptReportBatchEntry(report, parent);
                expect(
                  appendSelectedTranscriptReportInTransaction(current, legacy, parent, selected, {
                    scheduleProjectionReconcile: false,
                    onProjectionReconcileNeeded() {},
                  }),
                ).toBe(true);
                parent = selected.eventId;
              }
            },
            { agentId: legacy.agentId, path: database.path, env: state.env },
          ),
        );
        expect(baseline.counts).toEqual({
          header: count,
          window: count,
          generation: count,
          mutation: count,
        });
        let rejectCommit = false;
        const backend = runWithSqliteWorkerStateContext(
          { environment: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir } },
          () =>
            bindSqliteWorkerBackend(
              { resolved: batch, fence: {} },
              {
                database: database.db,
                databasePath: database.path,
                admit(stage) {
                  if (stage === "commit" && rejectCommit) {
                    throw new Error("Synthetic cursor commit refusal");
                  }
                },
              },
            ),
        );
        const { port1, port2 } = new MessageChannel();
        const run = (entries: PreparedTranscriptReportBatchEntry[]) =>
          withSqliteWorkerOperationAdmission({ port: port1 }, () =>
            backend.execute({ type: "appendBatch", input: { reports: entries } }),
          );
        try {
          const optimized = measure(database, () => run(reports));
          expect(optimized.result).toMatchObject({
            ok: true,
            value: { committed: true, accepted: count, appended: count },
          });
          expect(optimized.counts).toEqual({ header: 1, window: 1, generation: 1, mutation: 1 });
          const committed = await loadTranscriptEvents(batch);
          const old = await loadTranscriptEvents(legacy);
          expect(committed).toHaveLength(count + 2);
          expect(JSON.stringify(committed.slice(2))).toBe(JSON.stringify(old.slice(2)));
          const after = readTranscriptContextVersionInTransaction(database, batch.sessionId);
          expect(after.generation).toBe(before.generation);
          expect(after.rawSeq).toBe((before.rawSeq ?? -1) + count);
          expect(after.updatedAt).toBeGreaterThan(before.updatedAt ?? -1);
          const duplicate = measure(database, () => run(reports));
          expect(duplicate.result).toMatchObject({
            ok: true,
            value: { accepted: count, appended: 0 },
          });
          expect(duplicate.counts).toEqual({ header: 0, window: 0, generation: 0, mutation: 0 });
          expect(readTranscriptContextVersionInTransaction(database, batch.sessionId)).toEqual(
            after,
          );
          expect(await loadTranscriptEvents(batch)).toEqual(committed);
          rejectCommit = true;
          expect(() => run([prepared("refused-a"), prepared("refused-b")])).toThrow(
            "Synthetic cursor commit refusal",
          );
          expect(readTranscriptContextVersionInTransaction(database, batch.sessionId)).toEqual(
            after,
          );
          expect(await loadTranscriptEvents(batch)).toEqual(committed);
        } finally {
          port1.close();
          port2.close();
          await backend.close();
        }
      },
    );
  },
);

it("includes first-header creation in the single committed batch mutation", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "report-cursor-first-header" },
    async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const resolved = {
        agentId: "main",
        sessionKey: "agent:main:cursor-first",
        sessionId: "cursor-first",
        path: database.path,
        env: state.env,
      };
      await upsertSessionEntryCore(resolved, { sessionId: resolved.sessionId, updatedAt: 1 });
      const backend = runWithSqliteWorkerStateContext(
        { environment: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir } },
        () =>
          bindSqliteWorkerBackend(
            { resolved, fence: {} },
            { database: database.db, databasePath: database.path, admit() {} },
          ),
      );
      const { port1, port2 } = new MessageChannel();
      try {
        const measured = measure(database, () =>
          withSqliteWorkerOperationAdmission({ port: port1 }, () =>
            backend.execute({
              type: "appendBatch",
              input: { reports: [prepared("first"), prepared("second")] },
            }),
          ),
        );
        expect(measured.result).toMatchObject({ ok: true, value: { accepted: 2, appended: 2 } });
        expect(measured.counts.mutation).toBe(1);
        const events = await loadTranscriptEvents(resolved);
        expect(events).toHaveLength(3);
        expect(asOptionalRecord(events[0])?.type).toBe("session");
        expect(
          events
            .slice(1)
            .map((event) => asOptionalRecord(asOptionalRecord(event)?.details)?.packetId),
        ).toEqual(["first", "second"]);
      } finally {
        port1.close();
        port2.close();
        await backend.close();
      }
    },
  );
});
