import { assertModelSelectionUnlocked } from "../../sessions/model-overrides.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import {
  buildForkedChildTranscriptEvents,
  estimateParentForkPromptTokens,
  planParentForkDecision,
  resolveParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { InitialSessionContextRead } from "./session-initial-context-read.types.js";
import type { SessionEntry } from "./types.js";

/** The enclosing cohort owns one transaction for the row, completed path, and version. */
export function readInitialSessionContextInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  params: {
    source: CapturedSessionEntryReadSource & { databaseIdentity: string };
    sessionKey: string;
    entry: SessionEntry;
    targetSessionId: string;
    maxTokens?: number;
  },
): InitialSessionContextRead {
  if (!database.db.isTransaction) {
    throw new Error("Initial conversation context requires its entry cohort snapshot.");
  }
  if (!params.targetSessionId.trim() || params.targetSessionId === params.entry.sessionId) {
    throw new Error("Initial conversation context requires a different target identity.");
  }
  assertModelSelectionUnlocked(params.entry);
  const source = resolveParentForkSourceTranscript(
    loadTranscriptEventsFromDatabase(database, params.entry.sessionId),
    "last-completed",
  );
  if (!source) {
    throw new Error("Initial conversation context source has no readable transcript.");
  }
  const decision = planParentForkDecision(params.entry, estimateParentForkPromptTokens(source), {
    maxTokens: params.maxTokens,
    preferTranscriptEstimate: true,
  });
  if (decision.status === "skip") {
    return { status: "skipped", decision };
  }
  const sourceThrough = source.leafId
    ? readActiveTranscriptEntryAnchorInTransaction({
        database,
        resolved: {
          agentId: database.agentId,
          path: database.path,
          sessionKey: params.sessionKey,
          sessionId: params.entry.sessionId,
        },
        entryId: source.leafId,
      })
    : undefined;
  if (source.leafId && !sourceThrough) {
    throw new Error("Initial conversation context lost its completed source anchor.");
  }
  return {
    status: "prepared",
    ...(source.contextStatus ? { contextStatus: source.contextStatus } : {}),
    context: {
      source: { ...params.source },
      sourceSessionKey: params.sessionKey,
      sourceEntry: {
        sessionId: params.entry.sessionId,
        lifecycleRevision: params.entry.lifecycleRevision,
      },
      sourceVersion: readTranscriptContextVersionInTransaction(database, params.entry.sessionId),
      ...(sourceThrough ? { sourceThrough } : {}),
      targetSessionId: params.targetSessionId,
      events: buildForkedChildTranscriptEvents({
        parentSessionFile: params.sessionKey,
        source,
        targetSessionId: params.targetSessionId,
      }),
    },
  };
}
