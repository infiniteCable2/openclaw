import type { SessionTreeEntry } from "@openclaw/agent-core";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { normalizeSessionContextEntryBoundaries } from "./session-entry-navigation.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import { assertSessionModelContextBatchBudget } from "./session-model-context-batch-limits.js";
import type { ContextEntry } from "./session-model-context-selection.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { transcriptEventModelNavigationSql } from "./transcript-payload.js";
import {
  scanSessionTranscriptNavigation,
  visitSessionTranscriptTreePathNodes,
  type SessionTranscriptTreeNode,
} from "./transcript-tree.js";

export type SessionTranscriptModelContextRange = {
  through: TranscriptEntryAnchor;
  limits: SessionModelContextLimits;
};

export type SessionTranscriptModelContextRangeResult =
  | { ok: true; context: SessionTranscriptModelContext }
  | { ok: false; reason: "source-range-unverified" | "source-range-over-capacity" };

/** Two historical ranges share navigation only inside this exact SQLite read snapshot. */
export function readSessionTranscriptModelContextRanges(
  scope: SessionTranscriptReadScope,
  ranges: readonly SessionTranscriptModelContextRange[],
  readRange: (
    database: OpenClawAgentReadOnlyDatabase,
    entries: ContextEntry[],
    range: SessionTranscriptModelContextRange,
  ) => SessionTranscriptModelContext,
): SessionTranscriptModelContextRangeResult[] {
  assertSessionModelContextBatchBudget(ranges);
  if (ranges.length === 0) {
    return [];
  }
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const ordered = ranges
            .map((range, index) => ({ range, index }))
            .toSorted((a, b) => a.range.through.rawSeq - b.range.through.rawSeq);
          const results: SessionTranscriptModelContextRangeResult[] = [];
          const nodes: SessionTranscriptTreeNode<ContextEntry>[] = [];
          const byId = new Map<string, SessionTranscriptTreeNode<ContextEntry>>();
          let next = 0;
          const finish = () => {
            const { range, index } = ordered[next++]!;
            try {
              if (!byId.has(range.through.entryId)) {
                throw new SessionTranscriptReadFenceError(
                  "Completed-turn anchor is outside the admitted context",
                );
              }
              const path: SessionTranscriptTreeNode<ContextEntry>[] = [];
              const valid = visitSessionTranscriptTreePathNodes(
                byId,
                range.through.entryId,
                new Set(),
                (node) => path.push(node),
              );
              const entries = normalizeSessionContextEntryBoundaries(
                valid
                  ? path.toReversed().map(({ entry, parentId }) => ({ ...entry, parentId }))
                  : [],
                nodes,
              );
              results[index] = {
                ok: true,
                context: readRange(database, entries, range),
              };
            } catch (error) {
              if (
                !(error instanceof SessionTranscriptReadFenceError) &&
                !(error instanceof RangeError)
              ) {
                throw error;
              }
              results[index] = {
                ok: false,
                reason:
                  error instanceof RangeError
                    ? "source-range-over-capacity"
                    : "source-range-unverified",
              };
            }
          };
          const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
          const navigation = readTranscriptNavigationEntries(
            database,
            resolved,
            ordered.at(-1)!.range.through,
            fence,
          );
          // Resolve an endpoint before a later control or duplicate ID can affect its prefix.
          scanSessionTranscriptNavigation(
            (function* () {
              for (const entry of navigation) {
                while (next < ordered.length && ordered[next]!.range.through.rawSeq < entry.seq) {
                  finish();
                }
                yield entry;
              }
            })(),
            {
              byId,
              addNode: (node) => nodes.push(node),
              resetDescendantIds: new Set(),
              invalidLeafControlIds: new Set(),
            },
          );
          while (next < ordered.length) {
            finish();
          }
          return results;
        },
        { operationLabel: "session context range batch read" },
      ),
    toDatabaseOptions(resolved),
  );
  return result.found
    ? result.value
    : ranges.map<SessionTranscriptModelContextRangeResult>(() => ({
        ok: false,
        reason: "source-range-unverified",
      }));
}

export function readTranscriptNavigationEntries(
  database: Pick<OpenClawAgentDatabase, "db">,
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>,
  through?: TranscriptEntryAnchor,
  fence?: ReturnType<typeof resolveSqliteSessionTranscriptReadFence>,
): ContextEntry[] {
  return Array.from(
    iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(["seq", transcriptEventModelNavigationSql().as("navigation_json")])
        .where("session_id", "=", resolved.sessionId)
        .$if(fence !== undefined, (q) => q.where("seq", "<", fence!.beforeRawSeq))
        .$if(through !== undefined, (q) => q.where("seq", "<=", through!.rawSeq))
        .orderBy("seq", "asc"),
    ),
    (row) => {
      // SAFETY: Codec-owned navigation retains canonical discriminants and parent links.
      return { ...(JSON.parse(row.navigation_json) as SessionTreeEntry), seq: row.seq };
    },
  );
}
