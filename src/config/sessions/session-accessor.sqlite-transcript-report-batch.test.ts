import { MessageChannel } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { withSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { appendSessionTranscriptReportBatch } from "./session-accessor.sqlite-transcript-reports.js";
import {
  prepareCustomTranscriptReport,
  prepareTranscriptReportBatchSelection,
  prepareTranscriptReportSelection,
} from "./session-accessor.sqlite-transcript-reports.kernel.js";
import type { PreparedTranscriptReportBatchEntry } from "./session-accessor.sqlite-transcript-reports.types.js";
import { bindSqliteWorkerBackend } from "./session-accessor.sqlite-transcript-reports.worker.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import type { SessionSourceAssertion, SessionSourcePredicate } from "./session-source-authority.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

const customType = "synthetic-observation";
function report(id: string) {
  return {
    report: {
      customType,
      content: `Synthetic fact ${id}.`,
      display: false,
      details: { packetId: id },
    },
    receipt: { field: "packetId", value: id },
  };
}
function prepared(id: string): PreparedTranscriptReportBatchEntry {
  const entry = report(id);
  return {
    ...prepareCustomTranscriptReport(entry.report, null, {
      kind: "custom",
      customTypes: [customType],
      receipt: entry.receipt,
    }),
    customType,
    receipt: entry.receipt,
  };
}

it("selects a bounded batch from one recipient branch and reads each matching old body at most once", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "report-batch-scaling" },
    async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:batch-scaling",
        sessionId: "batch-scaling",
        storePath: database.path,
        env: state.env,
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      for (const count of [10, 100, 213, 300]) {
        await replaceTranscriptEvents(scope, [
          { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
          ...Array.from({ length: count }, (_, index) => ({
            type: "custom_message",
            id: `old-${index}`,
            parentId: index === 0 ? null : `old-${index - 1}`,
            customType,
            content: `Old synthetic observation ${index}. ${"synthetic payload ".repeat(index % 2 === 0 ? 10 : 400)}`,
            display: false,
            details: { packetId: `old-${index}` },
          })),
        ]);
        const stored = asOptionalRecord(
          database.db
            .prepare(
              "SELECT sum(event_zstd IS NOT NULL) AS compressed, sum(event_json IS NOT NULL) AS identityRows FROM transcript_events WHERE session_id = ?",
            )
            .get(scope.sessionId),
        );
        expect(stored?.compressed).toBeGreaterThan(0);
        expect(stored?.identityRows).toBeGreaterThan(0);
        const resolved = { ...scope, path: database.path };
        const batch = Array.from({ length: 32 }, (_, index) => prepared(`new-${index}`));
        const observe = () =>
          trackSqliteStatementExecutions(database.db, ["branch", "payload"], (sql) =>
            sql.includes('as "report_json"') && sql.includes('from "transcript_events"')
              ? "branch"
              : sql.includes('as "event_json"') &&
                  sql.includes('from "transcript_events"') &&
                  sql.includes('"seq" =')
                ? "payload"
                : null,
          );
        const legacy = observe();
        const legacyStarted = performance.now();
        for (const entry of batch) {
          expect(
            prepareTranscriptReportSelection(database, resolved, {
              kind: "custom",
              customTypes: [customType],
              receipt: entry.receipt,
            }),
          ).toMatchObject({
            appendParentId: `old-${count - 1}`,
            latest: undefined,
            suppressed: false,
          });
        }
        const oldFacts = {
          queries: { ...legacy.counts },
          rows: { ...legacy.rowCounts },
          bytes: { ...legacy.textBytes },
          ms: performance.now() - legacyStarted,
        };
        legacy.restore();
        const counter = observe();
        const started = performance.now();
        try {
          const selected = prepareTranscriptReportBatchSelection(database, resolved, batch);
          expect(selected.appendParentId).toBe(`old-${count - 1}`);
          expect([...selected.existing]).toEqual([]);
          expect(counter.counts.branch).toBeLessThanOrEqual(2);
          expect(counter.counts.payload).toBeLessThanOrEqual(count);
          expect(counter.rowCounts.branch).toBeLessThanOrEqual(count + 2);
          console.info(
            JSON.stringify({
              benchmark: "native-report-selection",
              historyEvents: count,
              batch: batch.length,
              legacy: oldFacts,
              boundedBatch: {
                queries: counter.counts,
                rows: counter.rowCounts,
                bytes: counter.textBytes,
                ms: performance.now() - started,
              },
              rss: process.memoryUsage().rss,
            }),
          );
        } finally {
          counter.restore();
        }
      }
    },
  );
});

it("retains exact accepted prefixes, duplicate receipts and canonical parents across budget pauses", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "report-batch-prefix" },
    async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:batch-prefix",
        sessionId: "batch-prefix",
        storePath: database.path,
        env: state.env,
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [
        { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
        {
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "Current synthetic branch." },
        },
        {
          type: "custom_message",
          id: "inactive-receipt",
          parentId: "root",
          ...report("one").report,
        },
        {
          type: "message",
          id: "current",
          parentId: "root",
          message: { role: "user", content: "Continue separately." },
        },
      ]);
      const admissions: string[] = [];
      let rejectCommit = false;
      const backend = runWithSqliteWorkerStateContext(
        { environment: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir } },
        () =>
          bindSqliteWorkerBackend(
            {
              resolved: {
                agentId: scope.agentId,
                sessionId: scope.sessionId,
                sessionKey: scope.sessionKey,
                path: database.path,
              },
              fence: {},
            },
            {
              database: database.db,
              databasePath: database.path,
              admit(stage) {
                admissions.push(stage);
                if (stage === "commit" && rejectCommit) {
                  throw new Error("Synthetic host commit refusal");
                }
              },
            },
          ),
      );
      const { port1, port2 } = new MessageChannel();
      const run = (ids: string[], maxEvents: number) =>
        withSqliteWorkerOperationAdmission({ port: port1 }, () =>
          backend.execute({
            type: "appendBatch",
            input: {
              reports: ids.map(prepared),
              preserveContextLimits: { maxBytes: 1_000_000, maxEvents },
            },
          }),
        );
      try {
        const before = await loadTranscriptEvents(scope);
        const first = run(["one", "one", "two"], 4);
        expect(first).toMatchObject({
          ok: true,
          value: { committed: true, accepted: 2, appended: 1, deferred: true },
        });
        const after = await loadTranscriptEvents(scope);
        expect(after).toHaveLength(before.length + 1);
        expect(after.at(-1)).toMatchObject({ parentId: "current", details: { packetId: "one" } });
        expect(run(["one", "two"], 4)).toMatchObject({
          ok: true,
          value: { committed: false, accepted: 1, appended: 0, deferred: true },
        });
        expect(await loadTranscriptEvents(scope)).toEqual(after);
        expect(run(["one", "two", "three"], 20)).toMatchObject({
          ok: true,
          value: { committed: true, accepted: 3, appended: 2 },
        });
        const committed = await loadTranscriptEvents(scope);
        expect(committed.slice(-3).map((event) => asOptionalRecord(event)?.details)).toEqual([
          { packetId: "one" },
          { packetId: "two" },
          { packetId: "three" },
        ]);
        const tail = asOptionalRecord(committed.at(-1));
        expect(tail?.parentId).toBe(asOptionalRecord(committed.at(-2))?.id);
        rejectCommit = true;
        expect(() => run(["refused-a", "refused-b"], 20)).toThrow("Synthetic host commit refusal");
        expect(await loadTranscriptEvents(scope)).toEqual(committed);
        expect(admissions.filter((stage) => stage === "commit")).toHaveLength(4);
      } finally {
        port1.close();
        port2.close();
        await backend.close();
      }
    },
  );
});

it("rolls back a deferred first header and publishes only a committed native batch", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "report-batch-publication" },
    async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:batch-publication",
        sessionId: "batch-publication",
        env: state.env,
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      let deferred = 0;
      expect(
        await appendSessionTranscriptReportBatch(scope, [report("first")], {
          contextAdmission: {
            limits: { maxBytes: 1_000_000, maxEvents: 1 },
            onDeferred: () => deferred++,
          },
        }),
      ).toEqual({ ok: true, value: { accepted: 0, appended: 0, deferred: true } });
      expect(await loadTranscriptEvents(scope)).toEqual([]);
      expect(deferred).toBe(1);
      expect(
        await appendSessionTranscriptReportBatch(scope, [
          report("first"),
          report("first"),
          report("second"),
        ]),
      ).toEqual({ ok: true, value: { accepted: 3, appended: 2, deferred: false } });
      const after = await loadTranscriptEvents(scope);
      expect(
        after.filter((event) => asOptionalRecord(event)?.type === "custom_message"),
      ).toHaveLength(2);
      expect(await appendSessionTranscriptReportBatch(scope, [report("second")])).toEqual({
        ok: true,
        value: { accepted: 1, appended: 0, deferred: false },
      });
      expect(await loadTranscriptEvents(scope)).toEqual(after);
    },
  );
});

it("rechecks every source in a public batch and refuses the whole write when one source loses authority", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "report-batch-source-union" },
    async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const target = {
        agentId: "main",
        sessionKey: "agent:main:union-target",
        sessionId: "union-target",
        env: state.env,
        storePath: database.path,
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const sources = ["first", "second"].map((id) => ({
        ...target,
        sessionKey: `agent:main:source-${id}`,
        sessionId: `source-${id}`,
      }));
      for (const source of sources) {
        await upsertSessionEntryCore(source, {
          sessionId: source.sessionId,
          lifecycleRevision: "original",
          updatedAt: 1,
        });
        await replaceTranscriptEvents(source, [
          { type: "session", id: source.sessionId, version: CURRENT_SESSION_VERSION },
          {
            type: "message",
            id: "fact",
            parentId: null,
            message: { role: "user", content: "An authorized synthetic source fact." },
          },
        ]);
      }
      const captured = captureSessionEntryReadSource(database, undefined);
      const predicates: SessionSourcePredicate[] = sources.map((source) => ({
        source: captured,
        sessionKey: source.sessionKey,
        fields: ["sessionId", "lifecycleRevision"],
        expected: { sessionId: source.sessionId, lifecycleRevision: "original" },
        transcript: {
          sessionId: source.sessionId,
          version: readTranscriptContextVersionInTransaction(database, source.sessionId),
          consistency: "prefix",
        },
      }));
      let revoked = false;
      let releases = 0;
      const assertCurrent = () => {
        if (revoked) {
          throw new Error("Synthetic source owner retired");
        }
      };
      const source: SessionSourceAssertion = Object.assign(assertCurrent, {
        prepareSessionSource: async () => ({
          assertCurrent,
          checks: predicates.map((predicate) => ({
            predicate,
            refuse: (): never => {
              throw new Error("Synthetic union source refused");
            },
          })),
          release: () => {
            releases++;
          },
        }),
      });
      expect(
        await appendSessionTranscriptReportBatch(
          target,
          [report("source-first"), report("source-second")],
          { source },
        ),
      ).toEqual({ ok: true, value: { accepted: 2, appended: 2, deferred: false } });
      const before = await loadTranscriptEvents(target);
      await upsertSessionEntryCore(sources[1]!, {
        sessionId: sources[1]!.sessionId,
        lifecycleRevision: "replacement",
        updatedAt: 2,
      });
      await expect(
        appendSessionTranscriptReportBatch(
          target,
          [report("refused-first"), report("refused-second")],
          { source },
        ),
      ).rejects.toThrow("Synthetic union source refused");
      expect(await loadTranscriptEvents(target)).toEqual(before);
      revoked = true;
      await expect(
        appendSessionTranscriptReportBatch(target, [report("retired")], { source }),
      ).rejects.toThrow("Synthetic source owner retired");
      expect(await loadTranscriptEvents(target)).toEqual(before);
      expect(releases).toBe(3);
    },
  );
});
