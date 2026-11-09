import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
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

/** Raw navigation includes the header, which is not a parent-linked tree entry. */
export type TranscriptContextNavigationEntry = ContextEntry | { type: "session"; seq: number };

/** Exact snapshot retained while the batch reader hydrates one selected range. */
export type PreparedTranscriptContextRange = {
  database: OpenClawAgentReadOnlyDatabase;
  entries: ContextEntry[];
  header?: Pick<ContextEntry, "seq">;
};

/** Two historical ranges share navigation only inside this exact SQLite read snapshot. */
export function readSessionTranscriptModelContextRanges(
  scope: SessionTranscriptReadScope,
  ranges: readonly SessionTranscriptModelContextRange[],
  readNavigation: (
    database: OpenClawAgentReadOnlyDatabase,
    resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>,
    through?: TranscriptEntryAnchor,
    fence?: ReturnType<typeof resolveSqliteSessionTranscriptReadFence>,
  ) => TranscriptContextNavigationEntry[],
  readRange: (
    snapshot: PreparedTranscriptContextRange,
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
          let header: Pick<ContextEntry, "seq"> | undefined;
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
              // Range projection can reparent its entries. Preserve the shared
              // historical navigation nodes for the remaining endpoint.
              const detached: ContextEntry[] = [];
              if (valid) {
                for (const { entry, parentId } of path.toReversed()) {
                  detached.push({ ...entry, parentId });
                }
              }
              const entries = normalizeSessionContextEntryBoundaries(detached, nodes);
              results[index] = {
                ok: true,
                context: readRange({ database, entries, header }, range),
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
          const navigation = readNavigation(
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
                if (entry.type === "session") {
                  header ??= { seq: entry.seq };
                  continue;
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
