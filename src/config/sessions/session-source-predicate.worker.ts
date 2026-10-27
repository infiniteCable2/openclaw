import { isDeepStrictEqual } from "node:util";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { SessionTranscriptContextVersion } from "./session-accessor.sqlite-contract.js";
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

type SourceDatabase = Parameters<typeof readExactSessionEntryRowValidated>[0];
type SourceIdentity = ReturnType<typeof readOpenClawAgentDatabaseIdentity>["identity"];
type PrefixProof = {
  identity: SourceIdentity;
  path: string;
  sessionKey: string;
  expected: SessionTranscriptContextVersion | undefined;
  current: SessionTranscriptContextVersion;
};

/** One report operation owns these proofs; live permission facts are never retained. */
export function createSessionSourceValidationScope(database: SourceDatabase) {
  const proofs = new Map<string, PrefixProof>();
  return {
    read(sources: SessionEntryPatchCommit["sources"]) {
      return readSourceValidation(
        database,
        sources,
        readOpenClawAgentDatabaseIdentity(database).identity,
        undefined,
        proofs,
      );
    },
    clear() {
      proofs.clear();
    },
  };
}

export function readSessionSourceValidation(
  database: Parameters<typeof readExactSessionEntryRowValidated>[0],
  sources: SessionEntryPatchCommit["sources"],
  identity = readOpenClawAgentDatabaseIdentity(database).identity,
  entries?: ReadonlyMap<string, SessionEntry | undefined>,
): SessionSourceValidation {
  return readSourceValidation(database, sources, identity, entries);
}

function readSourceValidation(
  database: SourceDatabase,
  sources: SessionEntryPatchCommit["sources"],
  identity: SourceIdentity,
  entries?: ReadonlyMap<string, SessionEntry | undefined>,
  proofs?: Map<string, PrefixProof>,
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
      !matchesTranscript(database, source, identity, proofs)
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
  identity: SourceIdentity,
  proofs?: Map<string, PrefixProof>,
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
  const current = proofs
    ? readTranscriptContextVersionInTransaction(database, source.transcript.sessionId)
    : undefined;
  const proof = proofs?.get(source.transcript.sessionId);
  if (
    proof &&
    proof.identity === identity &&
    proof.path === source.source.path &&
    proof.sessionKey === source.sessionKey &&
    isDeepStrictEqual(proof.expected, source.transcript.version) &&
    isDeepStrictEqual(proof.current, current)
  ) {
    return true;
  }
  proofs?.delete(source.transcript.sessionId);
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
    if (proofs && current) {
      proofs.set(source.transcript.sessionId, {
        identity,
        path: source.source.path,
        sessionKey: source.sessionKey,
        expected: source.transcript.version ? { ...source.transcript.version } : undefined,
        current: { ...current },
      });
    }
    return true;
  } catch (error) {
    if (!(error instanceof SessionTranscriptReadFenceError)) {
      throw error;
    }
    return false;
  }
}
