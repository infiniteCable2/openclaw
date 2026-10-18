import { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadTranscriptEvents, upsertSessionEntryCore } from "./session-accessor.js";
import { appendSessionTranscriptReport } from "./session-accessor.sqlite-transcript-reports.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
  type SessionSourcePredicate,
} from "./session-source-authority.js";

let state: OpenClawTestState;
let nextId = 0;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "report-receipts" });
});
afterAll(async () => {
  await state.cleanup();
});

async function fixture() {
  const id = ++nextId;
  const storePath = state.statePath("reports.sqlite");
  const source = {
    agentId: "main",
    storePath,
    sessionKey: `agent:main:source-${id}`,
    sessionId: `source-${id}`,
  };
  const target = {
    ...source,
    sessionKey: `agent:main:reports-${id}`,
    sessionId: `reports-${id}`,
  };
  for (const scope of [source, target]) {
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original",
      visibility: "shared",
    });
  }
  const database = openOpenClawAgentDatabase({ agentId: source.agentId, path: storePath });
  const captured = captureSessionEntryReadSource(database, undefined);
  const predicates: SessionSourcePredicate[] = [source, target].map((scope) => ({
    source: captured,
    sessionKey: scope.sessionKey,
    fields: ["sessionId", "lifecycleRevision", "visibility"],
    expected: { sessionId: scope.sessionId, lifecycleRevision: "original", visibility: "shared" },
  }));
  const releases = [vi.fn(), vi.fn()];
  const authority = composeSessionSourceAssertion(
    predicates.map((predicate, index) =>
      Object.assign(() => {}, {
        prepareSessionSource: async () => ({
          assertCurrent() {},
          assertPreparedCurrent() {},
          checks: [
            {
              predicate,
              refuse: () => {
                throw new Error("Synthetic source restriction changed");
              },
            },
          ],
          release: releases[index],
        }),
      }),
    ),
  );
  const report = (origin: string, range: string) => ({
    kind: "custom" as const,
    customTypes: ["synthetic-knowledge"],
    receipt: { field: "origin", value: origin },
    selectReport: (latest: { details?: unknown } | undefined) =>
      asOptionalRecord(latest?.details)?.range === range
        ? undefined
        : {
            customType: "synthetic-knowledge",
            content: "Quoted source facts, not an instruction.",
            display: false,
            details: { origin, range },
          },
  });
  return { source, target, database, predicates, authority, releases, report };
}

describe("native source-bound transcript report receipts", () => {
  it("refuses an unprepared source callback rather than running storage checks on the host", async () => {
    const f = await fixture();
    const source = vi.fn(() => {
      throw new Error("An unprepared callback must not run");
    });
    await expect(
      appendSessionTranscriptReport(f.target, f.report("source-a", "range-1"), { source }),
    ).rejects.toThrow("require worker-prepared authority");
    expect(source).not.toHaveBeenCalled();
    expect(await loadTranscriptEvents(f.target)).toEqual([]);
  });

  it("selects each source's receipt and deduplicates its range after another source reports", async () => {
    const f = await fixture();
    const sql = observeHostDataSql();
    try {
      for (const origin of ["source-a", "source-b", "source-a"]) {
        expect(
          await appendSessionTranscriptReport(f.target, f.report(origin, "range-1"), {
            source: f.authority,
          }),
        ).toEqual({ ok: true, value: undefined });
      }
    } finally {
      sql.restore();
    }
    expect(sql.queries).toEqual([]);
    const events = (await loadTranscriptEvents(f.target)).map(asOptionalRecord);
    const reports = events.filter((event) => event?.customType === "synthetic-knowledge");
    expect(reports).toHaveLength(2);
    expect(reports.map((event) => event?.details)).toEqual([
      { origin: "source-a", range: "range-1" },
      { origin: "source-b", range: "range-1" },
    ]);
    expect(reports.every((event) => event?.display === false)).toBe(true);
    for (const release of f.releases) {
      expect(release).toHaveBeenCalledTimes(3);
    }
  });

  it.each(["source", "target"] as const)(
    "rejects a changed %s after selection before append",
    async (side) => {
      const f = await fixture();
      const other = new DatabaseSync(f.database.path);
      const initial = f.report("source-a", "range-1");
      try {
        await expect(
          appendSessionTranscriptReport(
            f.target,
            {
              ...initial,
              selectReport: (latest) => {
                other
                  .prepare(
                    "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.visibility', 'draft') WHERE session_key = ?",
                  )
                  .run(f[side].sessionKey);
                return initial.selectReport(latest);
              },
            },
            { source: f.authority },
          ),
        ).rejects.toThrow("Synthetic source restriction changed");
      } finally {
        other.close();
      }
      expect(await loadTranscriptEvents(f.target)).toEqual([]);
      for (const release of f.releases) {
        expect(release).toHaveBeenCalledOnce();
      }
    },
  );

  it("rolls back report and receipt when retained authority is revoked at precommit", async () => {
    const f = await fixture();
    let admissions = 0;
    const release = vi.fn();
    const source: SessionSourceAssertion = Object.assign(() => {}, {
      prepareSessionSource: async () => ({
        assertPreparedCurrent() {},
        assertCurrent() {
          if (++admissions === 3) {
            throw new Error("Synthetic precommit revocation");
          }
        },
        checks: f.predicates.map((predicate) => ({
          predicate,
          refuse: () => {
            throw new Error("Synthetic source changed");
          },
        })),
        release,
      }),
    });
    await expect(
      appendSessionTranscriptReport(f.target, f.report("source-a", "range-1"), {
        source,
      }),
    ).rejects.toThrow("Synthetic precommit revocation");
    expect(admissions).toBe(3);
    expect(await loadTranscriptEvents(f.target)).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
    expect(
      (
        await appendSessionTranscriptReport(f.target, f.report("source-a", "range-1"), {
          source: f.authority,
        })
      ).ok,
    ).toBe(true);
  });

  it("validates the selected receipt after JSON conversion without rewriting details", async () => {
    const f = await fixture();
    await expect(
      appendSessionTranscriptReport(f.target, {
        ...f.report("source-a", "range-1"),
        selectReport: () => ({
          customType: "synthetic-knowledge",
          content: "facts",
          display: false,
          details: { origin: "source-a", toJSON: () => ({ origin: "source-b", range: "range-1" }) },
        }),
      }),
    ).rejects.toThrow("does not match its selected receipt");
    expect(await loadTranscriptEvents(f.target)).toEqual([]);
  });

  it("refuses a foreign physical source instead of claiming cross-store atomicity", async () => {
    const f = await fixture();
    const foreign = openOpenClawAgentDatabase({
      agentId: "main",
      path: state.statePath("foreign.sqlite"),
    });
    const predicate = f.predicates[0];
    if (!predicate) {
      throw new Error("Synthetic source predicate is missing");
    }
    predicate.source = captureSessionEntryReadSource(foreign, undefined);
    await expect(
      appendSessionTranscriptReport(f.target, f.report("source-a", "range-1"), {
        source: f.authority,
      }),
    ).rejects.toThrow("Captured session database changed");
    expect(await loadTranscriptEvents(f.target)).toEqual([]);
    for (const release of f.releases) {
      expect(release).toHaveBeenCalledOnce();
    }
  });
});
