import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-read-scope.js";
import { getSessionKysely, toDatabaseOptions } from "./session-accessor.sqlite-scope-helpers.js";
import {
  assertSessionTranscriptContextAnchorInDatabase,
  type TranscriptSourceAuthority,
} from "./session-accessor.sqlite-transcript-anchor.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { ContextEntry } from "./session-model-context-window.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { transcriptEventModelNavigationSql } from "./transcript-payload.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

/** Unadmitted context retains the prefix captured by its original read snapshot. */
export function validateSessionTranscriptContextVersion(
  scope: SessionTranscriptReadScope,
  version: SessionTranscriptContextVersion | undefined,
): void {
  validateDetachedSessionTranscriptContext(scope, { version });
}

function validateContextVersion(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  version: SessionTranscriptContextVersion | undefined,
  consistency: "exact" | "prefix",
): void {
  const current = readTranscriptContextVersionInTransaction(database, sessionId);
  if (
    current.generation === version?.generation &&
    current.rawSeq === version?.rawSeq &&
    current.updatedAt === version?.updatedAt
  ) {
    return;
  }
  const changed = () =>
    new SessionTranscriptReadFenceError("Session transcript changed during context read");
  if (
    consistency === "exact" ||
    !version?.generation ||
    current.generation !== version.generation ||
    version.rawSeq === null ||
    current.rawSeq === null ||
    current.rawSeq <= version.rawSeq
  ) {
    throw changed();
  }
  // Generation preserves prefix bytes; navigation must also preserve the original path.
  const entries = Array.from(
    iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(["seq", transcriptEventModelNavigationSql(database.db).as("navigation_json")])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    ),
    (row) => {
      // SAFETY: The codec owns the navigation object; sequence comes from the same row.
      const entry = JSON.parse(row.navigation_json) as ContextEntry;
      entry.seq = row.seq;
      return entry;
    },
  );
  const headSeq = version.rawSeq;
  const prefix = scanSessionTranscriptTree(entries.filter((entry) => entry.seq <= headSeq));
  const tree = scanSessionTranscriptTree(entries);
  const suffix = tree.nodes.filter(({ entry }) => entry.seq > headSeq);
  const expected = [...selectSessionTranscriptTreePathNodes(prefix, prefix.leafId), ...suffix];
  const path = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  if (
    entries.at(-1)?.seq !== current.rawSeq ||
    suffix.some(({ entry }) =>
      ["compaction", "reset", "leaf", "branch_summary"].includes(entry.type),
    ) ||
    expected.length !== path.length ||
    expected.some(
      (node, index) => node.id !== path[index]?.id || node.parentId !== path[index]?.parentId,
    )
  ) {
    throw changed();
  }
}

/** Revalidate admission after an asynchronous read before accepting its detached result. */
export function validateSessionTranscriptContextAdmission(
  scope: SessionTranscriptReadScope,
  admission: UserTurnTranscriptAdmissionReceipt | undefined,
): void {
  if (!admission) {
    return;
  }
  validateDetachedSessionTranscriptContext(scope, { admission });
}

type TranscriptContextValidation = {
  version?: SessionTranscriptContextVersion;
  admission?: UserTurnTranscriptAdmissionReceipt;
  through?: TranscriptEntryAnchor;
  from?: TranscriptEntryAnchor;
  expectedAuthority?: TranscriptSourceAuthority;
};

/** Released validators share admission; only multi-statement version reads need a snapshot. */
function validateDetachedSessionTranscriptContext(
  scope: SessionTranscriptReadScope,
  validation: Pick<TranscriptContextValidation, "version" | "admission">,
): void {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const validate = () => {
      validateSessionTranscriptContextInDatabase(database, resolved, validation, "prefix");
    };
    return validation.admission ? validate() : runSqliteReadSnapshotSync(database.db, validate);
  }, toDatabaseOptions(resolved));
  if (!result.found && (validation.admission || validation.version)) {
    throw new SessionTranscriptReadFenceError(
      validation.admission
        ? "Current-turn transcript admission is no longer readable"
        : "Session transcript changed during context read",
    );
  }
}

/** Validate detached context using the final reader's transaction-local facts. */
export function validateSessionTranscriptContextInDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>,
  validation: TranscriptContextValidation,
  consistency: "exact" | "prefix" = "exact",
): void {
  const { version, admission, through } = validation;
  if (admission) {
    if (
      !runWithSessionTranscriptReadFence(admission, () =>
        resolveSqliteSessionTranscriptReadFence({ database, ...resolved }),
      )
    ) {
      throw new SessionTranscriptReadFenceError(
        "Current-turn transcript admission is no longer readable",
      );
    }
  } else if (!through) {
    validateContextVersion(database, resolved.sessionId, version, consistency);
  }
  if (through) {
    assertSessionTranscriptContextAnchorInDatabase(
      database,
      resolved,
      through,
      validation.expectedAuthority,
    );
  }
  if (validation.from) {
    if (
      !through ||
      validation.from.generation !== through.generation ||
      validation.from.rawSeq > through.rawSeq
    ) {
      throw new SessionTranscriptReadFenceError(
        "Private contribution range changed during context read",
      );
    }
    assertSessionTranscriptContextAnchorInDatabase(
      database,
      resolved,
      validation.from,
      validation.expectedAuthority,
    );
  }
}
