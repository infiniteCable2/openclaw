import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import {
  readCurrentProjectionSnapshot,
  selectActiveTranscriptIdentityRows,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import {
  createTranscriptRawDeltaCursor,
  readTranscriptRawDeltaFromProjection,
} from "./session-accessor.sqlite-raw-delta-read.js";
import { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { SessionTranscriptColdError } from "./session-transcript-cold-error.js";
import type {
  SessionTranscriptMaintenanceFacts,
  SessionTranscriptMaintenanceRead,
} from "./session-transcript-hydration.types.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

const MAX_SUFFIX_ROWS = 96;
const MAX_REPORT_BYTES = 1_000_000;

/** An authoritative active-path extension, with ordinary message bodies kept in SQLite. */
export function readActiveTranscriptReportSuffix(
  database: OpenClawAgentReadOnlyDatabase,
  target: SessionTranscriptRuntimeTarget,
  request: Extract<SessionTranscriptMaintenanceRead, { operation: "active-report-suffix" }>,
): SessionTranscriptMaintenanceFacts {
  const kind = "transcript-maintenance";
  const { after } = request;
  const rawSeq = request.expectedVersion.rawSeq;
  if (
    rawSeq === null ||
    !Number.isSafeInteger(after.rawSeq) ||
    after.rawSeq < -1 ||
    rawSeq <= after.rawSeq ||
    rawSeq - after.rawSeq > MAX_SUFFIX_ROWS ||
    request.expectedVersion.generation !== after.generation ||
    resolveSqliteSessionTranscriptReadFence({ database, ...target })
  ) {
    return { kind };
  }
  const resolved = resolveSqliteTranscriptReadScope(target);
  const fromProjection = (projection: CurrentTranscriptProjection) => {
    if (
      projection.hasUnindexedPrefix ||
      !isDeepStrictEqual(projection.version, request.expectedVersion)
    ) {
      return undefined;
    }
    const hasBaseRow = after.rawSeq >= 0;
    if (hasBaseRow !== (after.leafEntryId !== null)) {
      return undefined;
    }
    const start = hasBaseRow ? after.rawSeq : 0;
    const identities = executeSqliteQuerySync(
      database.db,
      selectActiveTranscriptIdentityRows(database)
        .select([
          "active.event_seq",
          "identity.event_id",
          "identity.event_type",
          "identity.parent_id",
        ])
        .where("active.session_id", "=", resolved.sessionId)
        .where("active.event_seq", ">=", start)
        .where("active.event_seq", "<=", rawSeq)
        .orderBy("active.event_seq", "asc")
        .limit(MAX_SUFFIX_ROWS + 1),
    ).rows;
    if (identities.length !== rawSeq - start + 1) {
      return undefined;
    }
    let parent = after.leafEntryId;
    for (const [index, row] of identities.entries()) {
      if (
        row.event_seq !== start + index ||
        (row.event_type !== "message" && row.event_type !== "custom_message")
      ) {
        return undefined;
      }
      if (hasBaseRow && index === 0 ? row.event_id !== parent : row.parent_id !== parent) {
        return undefined;
      }
      parent = row.event_id;
    }
    if (parent !== projection.state.leafEventId) {
      return undefined;
    }
    const page = readTranscriptRawDeltaFromProjection(projection, {
      cursor: createTranscriptRawDeltaCursor({
        agentId: resolved.agentId,
        sessionId: resolved.sessionId,
        generation: after.generation,
        lastSeq: after.rawSeq,
      }),
      activePathOnly: true,
      customMessageDetailsOnly: true,
      customTypes: request.customTypes,
      maxEvents: MAX_SUFFIX_ROWS,
      maxBytes: MAX_REPORT_BYTES,
    });
    if (page.kind !== "page" || page.hasMore || page.requiredBytes !== undefined) {
      return undefined;
    }
    return {
      kind,
      version: projection.version,
      activeLeafEntryId: projection.state.leafEventId,
      events: page.events.map(({ event }) => event),
    } satisfies SessionTranscriptMaintenanceFacts;
  };
  try {
    const result = readCurrentProjectionSnapshot(database, resolved, fromProjection);
    return (result.kind === "value" ? result.value : undefined) ?? { kind };
  } catch (error) {
    if (!(error instanceof SessionTranscriptColdError)) {
      throw error;
    }
    // The canonical report reader owns cold restoration and its read fences.
    return { kind };
  }
}
