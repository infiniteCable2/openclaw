import { isDeepStrictEqual } from "node:util";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { selectConversationRowsFromDatabase } from "./session-accessor.sqlite-conversation-read.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { SessionEntryPatchCommit } from "./session-entry-patch.types.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export function readSessionSourceValidation(
  database: Parameters<typeof readExactSessionEntryRowValidated>[0],
  sources: SessionEntryPatchCommit["sources"],
  identity = readOpenClawAgentDatabaseIdentity(database).identity,
  entries?: ReadonlyMap<string, SessionEntry | undefined>,
): SessionSourceValidation {
  const validation: SessionSourceValidation = { conversationMatches: [] };
  for (const [index, source] of (sources ?? []).entries()) {
    if (identity !== source.source.databaseIdentity) {
      return { ...validation, refusedSource: { index, facts: { entry: undefined } } };
    }
    const entry = entries?.has(source.sessionKey)
      ? entries.get(source.sessionKey)
      : readExactSessionEntryRowValidated(database, source.sessionKey)?.entry;
    const members =
      source.members === undefined
        ? undefined
        : listSessionMembersInDatabase(database, source.sessionKey).map(
            (member) => member.identityId,
          );
    const alternatives = source.conversationAlternatives;
    let matching: number[] | undefined;
    if (alternatives) {
      const refs = [
        ...new Set(
          alternatives.flatMap((alternative) =>
            alternative.map(({ conversationRef }) => conversationRef),
          ),
        ),
      ];
      const rows = refs.length
        ? selectConversationRowsFromDatabase(database, {
            conversationRefs: refs,
            currentBindingOnly: true,
          })
        : [];
      const selected = new Map(
        rows.map((row) => [
          row.conversationRef,
          row.sessionKey && row.sessionId ? row.sessionKey : null,
        ]),
      );
      matching = alternatives.flatMap((alternative, alternativeIndex) =>
        alternative.every(
          (predicate) => (selected.get(predicate.conversationRef) ?? null) === predicate.sessionKey,
        )
          ? [alternativeIndex]
          : [],
      );
    }
    if (
      Boolean(entry) !== Boolean(source.expected) ||
      source.fields.some((field) => !isDeepStrictEqual(entry?.[field], source.expected?.[field])) ||
      matching?.length === 0 ||
      (members !== undefined && !isDeepStrictEqual(members, source.members)) ||
      !matchesTranscript(database, source)
    ) {
      return { ...validation, refusedSource: { index, facts: { entry, members } } };
    }
    if (matching) {
      validation.conversationMatches.push({ index, alternatives: matching });
    }
  }
  return validation;
}

function matchesTranscript(
  database: Parameters<typeof readExactSessionEntryRowValidated>[0],
  source: SessionSourcePredicate,
): boolean {
  if (!source.transcript) {
    return true;
  }
  if (source.transcript.consistency !== "prefix") {
    return isDeepStrictEqual(
      { ...readTranscriptContextVersionInTransaction(database, source.transcript.sessionId) },
      source.transcript.version,
    );
  }
  try {
    validateSessionTranscriptContextInDatabase(
      { db: database.db, path: source.source.path },
      {
        agentId: database.agentId,
        path: source.source.path,
        sessionKey: source.sessionKey,
        sessionId: source.transcript.sessionId,
      },
      { version: source.transcript.version },
      "prefix",
    );
    return true;
  } catch (error) {
    if (!(error instanceof SessionTranscriptReadFenceError)) {
      throw error;
    }
    return false;
  }
}
