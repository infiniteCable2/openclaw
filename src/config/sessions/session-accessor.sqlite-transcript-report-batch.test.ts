import { MessageChannel } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { withSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
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
import {
  appendSessionTranscriptReportBatch,
  readSessionTranscriptReportReceipts,
} from "./session-accessor.sqlite-transcript-reports.js";
import {
  prepareCustomTranscriptReport,
  prepareTranscriptReportBatchSelection,
  readReportBranch,
  readReportEvent,
  transcriptReportBatchReceiptKey,
} from "./session-accessor.sqlite-transcript-reports.kernel.js";
import type { PreparedTranscriptReportBatchEntry } from "./session-accessor.sqlite-transcript-reports.types.js";
import {
  bindSqliteWorkerBackend,
  observeTranscriptReportReceipts,
} from "./session-accessor.sqlite-transcript-reports.worker.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import type { SessionSourceAssertion, SessionSourcePredicate } from "./session-source-authority.js";
import { readActiveTranscriptEntryAnchorAsync } from "./session-transcript-anchor-read.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
import { prepareTranscriptPayload } from "./transcript-payload.js";
import { withSessionTranscriptWriteAssertion } from "./transcript-write-context.js";
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

it("observes exact known carriers independently of the prompt fence without reviving compacted reports", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "report-carrier-observation" },
    async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:receipt-observation",
        sessionId: "receipt-observation",
        storePath: database.path,
        env: state.env,
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        lifecycleRevision: "receipt-life",
        activeWriterRunId: "receipt-run",
        updatedAt: 1,
      });
      const header = { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION };
      const current = {
        type: "message",
        id: "current-user",
        parentId: null,
        message: { role: "user", content: "Current request", timestamp: 1 },
      };
      const carrier = {
        type: "custom_message",
        id: "known-carrier",
        parentId: "current-user",
        ...report("known").report,
      };
      const kept = {
        type: "message",
        id: "kept-message",
        parentId: "known-carrier",
        message: { role: "assistant", content: "Kept answer", timestamp: 2 },
      };
      await replaceTranscriptEvents(scope, [header, current, carrier, kept]);
      await waitForSessionTranscriptProjection(scope);
      const anchor = await readActiveTranscriptEntryAnchorAsync({ ...scope, entryId: current.id });
      if (!anchor) {
        throw new Error("Expected native user boundary");
      }
      const admission = { ...anchor, role: "user" as const, logicalTurnId: "receipt-turn" };
      const writer = {
        ...scope,
        expectedLifecycleRevision: "receipt-life",
        expectedWriterRunId: "receipt-run",
      };
      const queries = ["known", "absent"].map((id) => ({
        customType,
        receipt: { field: "packetId", value: id },
      }));
      const observe = () =>
        withSessionTranscriptWriteAssertion(
          writer,
          () => {},
          () =>
            runWithSessionTranscriptReadFence(admission, () =>
              readSessionTranscriptReportReceipts(writer, queries),
            ),
        );
      const before = await loadTranscriptEvents(scope);
      expect(await observe()).toMatchObject({
        ok: true,
        value: [
          {
            status: "active-model",
            eventId: carrier.id,
            report: { content: "Synthetic fact known.", details: { packetId: "known" } },
          },
          { status: "missing" },
        ],
      });
      expect(await loadTranscriptEvents(scope)).toEqual(before);
      await withSessionTranscriptWriteAssertion(
        writer,
        () => {},
        async () => {
          const manager = await SessionManager.openAsync(writer);
          await manager.appendCompactionAsync(
            "Earlier observations are retained in this native summary.",
            kept.id,
            100,
          );
        },
      );
      await waitForSessionTranscriptProjection(scope);
      expect(await observe()).toMatchObject({
        ok: true,
        value: [{ status: "historical", eventId: carrier.id }, { status: "missing" }],
      });
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        lifecycleRevision: "receipt-life",
        activeWriterRunId: "replacement-run",
        updatedAt: 2,
      });
      await expect(observe()).rejects.toThrow();
    },
  );
});

it("observes a full receipt batch with one reverse scan and one body read per relevant entry", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "report-observation-scaling" },
    async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:observation-scaling",
        sessionId: "observation-scaling",
        storePath: database.path,
        env: state.env,
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      for (const count of [30, 300]) {
        await replaceTranscriptEvents(scope, [
          { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
          ...Array.from({ length: count }, (_, index) => [
            {
              type: "custom_message",
              id: `known-${index}`,
              parentId: index === 0 ? null : `unrelated-${index - 1}`,
              customType,
              content: `Canonical body ${index}. ${"synthetic payload ".repeat(index % 2 === 0 ? 10 : 400)}`,
              display: false,
              details: {
                packetId: index === 0 || index === count - 1 ? "packet-zero" : `packet-${index}`,
                ...(index === count - 1 ? { contributionId: "latest-contribution" } : {}),
              },
            },
            {
              type: "custom_message",
              id: `unrelated-${index}`,
              parentId: `known-${index}`,
              customType: "unrelated-observation",
              content: "Unrelated body must not be selected. ".repeat(400),
              display: false,
            },
          ]).flat(),
        ]);
        await waitForSessionTranscriptProjection(scope);
        // Duplicate selectors and two different receipt fields resolve to ONE
        // latest canonical carrier. Missing IDs force the complete reverse scan.
        const queries = [
          { customType, receipt: { field: "packetId", value: "packet-zero" } },
          { customType, receipt: { field: "packetId", value: "packet-zero" } },
          { customType, receipt: { field: "contributionId", value: "latest-contribution" } },
          ...Array.from({ length: 29 }, (_, index) => ({
            customType,
            receipt: { field: "packetId", value: `missing-${index}` },
          })),
        ];
        const counter = trackSqliteStatementExecutions(
          database.db,
          ["branch", "payload", "membership"],
          (sql) =>
            sql.includes('as "report_json"') && sql.includes('from "transcript_events"')
              ? "branch"
              : sql.includes('as "event_json"') &&
                  sql.includes('from "transcript_events"') &&
                  (sql.includes('"seq" =') || sql.includes('"seq" in'))
                ? "payload"
                : sql.includes('select "active_position", "context_eligible"') &&
                    sql.includes('from "session_transcript_active_events"')
                  ? "membership"
                  : null,
        );
        const started = performance.now();
        try {
          const observed = observeTranscriptReportReceipts(
            database,
            { ...scope, path: database.path },
            queries,
          );
          expect(observed.slice(0, 3)).toMatchObject(
            Array.from({ length: 3 }, () => ({
              status: "active-model",
              eventId: `known-${count - 1}`,
              report: { content: expect.stringContaining(`Canonical body ${count - 1}.`) },
            })),
          );
          expect(observed.slice(3).every((entry) => entry.status === "missing")).toBe(true);
          expect(counter.counts.branch).toBeLessThanOrEqual(2);
          expect(counter.counts.payload).toBe(count);
          expect(counter.counts.membership).toBe(1);
          console.info(
            JSON.stringify({
              benchmark: "native-report-observation",
              historyEvents: count * 2,
              queryCount: queries.length,
              queries: counter.counts,
              rows: counter.rowCounts,
              ms: performance.now() - started,
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

it("selects canonical batch receipts without returning previous compressed bodies", async () => {
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
      for (const count of [10, 100, 213, 300, 600]) {
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
          trackSqliteStatementExecutions(database.db, ["branch", "payload", "receipt"], (sql) =>
            sql.includes('"receipt_details"') && sql.includes('as "envelope"')
              ? "receipt"
              : sql.includes('as "report_json"') && sql.includes('from "transcript_events"')
                ? "branch"
                : sql.includes('as "event_json"') &&
                    sql.includes('from "transcript_events"') &&
                    (sql.includes('"seq" =') || sql.includes('"seq" in'))
                  ? "payload"
                  : null,
          );
        const legacy = observe();
        const legacyStarted = performance.now();
        // The former batch algorithm selected the same canonical branch, then
        // issued one decoded payload query per matching historical report.
        const oldBranch = readReportBranch(database, scope.sessionId);
        for (const entry of oldBranch.path) {
          if (entry.type === "custom_message" && entry.customType === customType) {
            expect(readReportEvent(database, scope.sessionId, entry.seq)?.details).toEqual({
              packetId: entry.id,
            });
          }
        }
        expect(legacy.counts.payload).toBe(count);
        expect(legacy.rowCounts.payload).toBe(count);
        const oldFacts = {
          queries: { ...legacy.counts },
          rows: { ...legacy.rowCounts },
          bytes: { ...legacy.textBytes },
          ms: performance.now() - legacyStarted,
        };
        legacy.restore();
        const codec = resolveZstdCodec();
        if (!codec) {
          throw new Error("Native compressed-ledger coverage requires the runtime zstd codec");
        }
        const decode = vi.spyOn(codec, "decompress");
        const counter = observe();
        const started = performance.now();
        try {
          const selected = prepareTranscriptReportBatchSelection(database, resolved, batch);
          expect(selected.appendParentId).toBe(`old-${count - 1}`);
          expect([...selected.existing]).toEqual([]);
          expect(counter.counts.branch).toBeLessThanOrEqual(2);
          expect(counter.counts.payload).toBe(0);
          expect(counter.counts.receipt).toBe(1);
          expect(counter.rowCounts.receipt).toBe(0);
          expect(decode).toHaveBeenCalledTimes(Number(stored?.compressed));
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
                decompressions: decode.mock.calls.length,
                ms: performance.now() - started,
              },
              rss: process.memoryUsage().rss,
            }),
          );
          const duplicates = batch
            .slice(0, Math.min(32, count))
            .map((_, index) => prepared(`old-${index}`));
          expect(
            prepareTranscriptReportBatchSelection(database, resolved, duplicates).existing,
          ).toEqual(new Set(duplicates.map(transcriptReportBatchReceiptKey)));
          expect(counter.counts.payload).toBe(0);
          expect(counter.counts.receipt).toBe(2);
          expect(counter.rowCounts.receipt).toBeLessThanOrEqual(32);
          expect(decode).toHaveBeenCalledTimes(Number(stored?.compressed) * 2);
        } finally {
          counter.restore();
          decode.mockRestore();
        }
      }
    },
  );
});

it("matches exact own receipts on the canonical branch with compressed and exceptional JSON", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "report-receipt-semantics" },
    async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:receipt-semantics",
        sessionId: "receipt-semantics",
        storePath: database.path,
        env: state.env,
      };
      const special = "exceptional-observation";
      const bodies = [
        {
          type: customType,
          members: '"details":{"packetId":"discarded-field","packetId":"kept-field"}',
        },
        { type: customType, members: '"details":{"packetId":"discarded-number","packetId":9}' },
        {
          type: customType,
          members: '"details":{"packetId":"discarded-root"},"details":{"packetId":"kept-root"}',
        },
        { type: customType, members: '"details":{"packetId":42}' },
        { type: customType, members: '"details":{"__proto__":"own-prototype"}' },
        { type: customType, members: '"details":{"packetId":"value\\\"with-quote"}' },
        { type: special, members: '"details":["array-value"]' },
        { type: special, members: `"details":${JSON.stringify({ 'quoted"key': "quoted-key" })}` },
        { type: special, members: `"details":${JSON.stringify({ schlüssel: "unicode-key" })}` },
        { type: special, members: `"details":${JSON.stringify({ "nul\0key": "nul-key" })}` },
        { type: special, members: `"details":${JSON.stringify({ packetId: "unpaired-\ud800" })}` },
      ];
      const raw = bodies.map(
        ({ type, members }, index) =>
          `{"type":"custom_message","id":"case-${index}","parentId":"${index ? `case-${index - 1}` : "current"}","customType":${JSON.stringify(type)},"content":${JSON.stringify("Synthetic receipt body. ".repeat(160))},"display":false,${members}}`,
      );
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [
        { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
        {
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "Root." },
        },
        {
          type: "custom_message",
          id: "inactive",
          parentId: "root",
          ...report("off-branch").report,
        },
        {
          type: "message",
          id: "current",
          parentId: "root",
          message: { role: "user", content: "Current." },
        },
        ...raw.map((event) => JSON.parse(event) as unknown),
        {
          type: "compaction",
          id: "compact",
          parentId: `case-${raw.length - 1}`,
          summary: "Native summary.",
          firstKeptEntryId: "current",
          tokensBefore: 100,
        },
        {
          type: "custom_message",
          id: "side",
          parentId: "compact",
          appendMode: "side",
          ...report("side-only").report,
        },
      ]);
      // Exercise the original duplicate members retained by the native compressed
      // payload owner; parsing into the fixture alone would erase this contract.
      for (const [index, event] of raw.entries()) {
        const payload = prepareTranscriptPayload(database.db, event);
        if (index < 6) {
          expect(payload.event_zstd).not.toBeNull();
        }
        database.db
          .prepare(`UPDATE transcript_events SET event_json = ?, event_zstd = ?,
        event_utf8_bytes = ?, navigation_json = ? WHERE session_id = ? AND seq = ?`)
          .run(
            payload.event_json,
            payload.event_zstd,
            payload.event_utf8_bytes,
            payload.navigation_json,
            scope.sessionId,
            index + 4,
          );
      }
      const queries = [
        ...[
          "discarded-field",
          "kept-field",
          "discarded-number",
          "9",
          "discarded-root",
          "kept-root",
          "42",
          "off-branch",
          "side-only",
          'value"with-quote',
        ].map((value) => ({ customType, receipt: { field: "packetId", value } })),
        { customType, receipt: { field: "__proto__", value: "own-prototype" } },
        { customType, receipt: { field: "toString", value: "not-own" } },
        { customType: special, receipt: { field: "0", value: "array-value" } },
        { customType: special, receipt: { field: 'quoted"key', value: "quoted-key" } },
        { customType: special, receipt: { field: "schlüssel", value: "unicode-key" } },
        { customType: special, receipt: { field: "nul\0key", value: "nul-key" } },
        { customType: special, receipt: { field: "packetId", value: "unpaired-\ud800" } },
      ].map((entry) => Object.assign(prepared("unused"), entry));
      const selected = prepareTranscriptReportBatchSelection(
        database,
        { ...scope, path: database.path },
        queries,
      );
      expect(selected.appendParentId).toBe("compact");
      const expected = queries.filter(({ customType: type, receipt }) =>
        type === customType
          ? ["kept-field", "kept-root", 'value"with-quote', "own-prototype"].includes(receipt.value)
          : ["quoted-key", "unicode-key", "nul-key", "unpaired-\ud800"].includes(receipt.value),
      );
      expect(selected.existing).toEqual(new Set(expected.map(transcriptReportBatchReceiptKey)));
      database.db
        .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 0")
        .run(JSON.stringify({ type: "session", id: scope.sessionId, version: 1 }), scope.sessionId);
      expect(() =>
        prepareTranscriptReportBatchSelection(database, { ...scope, path: database.path }, queries),
      ).toThrow("Persisted legacy session transcripts require doctor/import migration");
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
        const committedVersion = readTranscriptContextVersionInTransaction(
          database,
          scope.sessionId,
        );
        rejectCommit = true;
        expect(() => run(["refused-a", "refused-b"], 20)).toThrow("Synthetic host commit refusal");
        expect(readTranscriptContextVersionInTransaction(database, scope.sessionId)).toEqual(
          committedVersion,
        );
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
        agentId: target.agentId,
        env: target.env,
        storePath: target.storePath,
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
