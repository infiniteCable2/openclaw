import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import { createReplySessionInitializationRevision } from "./session-accessor.entry-mutation.js";
import { resolveSessionEntryFromStore } from "./session-accessor.entry.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import type { SessionColdArchive } from "./session-accessor.sqlite-archive-types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { ReplySessionInitializationSnapshot } from "./session-accessor.types.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { assertSessionEntryCohortScope } from "./session-entry-cohort-scope.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export class SessionInitializationAgentScopeMismatchError extends Error {
  readonly code = "SESSION_INITIALIZATION_AGENT_SCOPE_MISMATCH";

  constructor(
    readonly agentId: string,
    readonly sessionKeyAgentId: string,
  ) {
    super(
      `Session initialization agent scope mismatch: explicit agent "${agentId}" does not match session key agent "${sessionKeyAgentId}".`,
    );
    this.name = "SessionInitializationAgentScopeMismatchError";
  }
}

export function assertSessionInitializationAgentScope(agentId: string, sessionKey: string): void {
  const normalizedAgentId = normalizeAgentId(agentId);
  const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (sessionKeyAgentId && normalizeAgentId(sessionKeyAgentId) !== normalizedAgentId) {
    throw new SessionInitializationAgentScopeMismatchError(normalizedAgentId, sessionKeyAgentId);
  }
}

type ReplySessionInitializationSelection = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  relatedSessionKeys?: readonly string[];
};

function loadReplySessionInitializationEntriesForMaintenance(
  params: ReplySessionInitializationSelection,
): Record<string, SessionEntry> {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteReadSnapshotSync(database.db, () => {
        assertCanonicalSqliteSessionKeysCurrent(database);
        const entries: Record<string, SessionEntry> = {};
        const currentKey = normalizeStoreSessionKey(params.sessionKey);
        const keys = new Set([currentKey, ...(params.relatedSessionKeys ?? [])]);
        // Related rows must share the current row's snapshot, including its stored
        // model parent. Lazy reads after preparation could inherit a different generation.
        for (const key of keys) {
          const sessionKey = normalizeStoreSessionKey(key);
          if (!sessionKey || entries[sessionKey]) {
            continue;
          }
          const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
          if (entry) {
            entries[sessionKey] = entry;
            if (sessionKey === currentKey && entry.parentSessionKey) {
              keys.add(entry.parentSessionKey);
            }
          }
        }
        return entries;
      }),
    toDatabaseOptions(resolveSqliteScope(params)),
  );
  return result.found ? result.value : {};
}

export async function loadReplySessionInitializationEntriesAsync(
  params: ReplySessionInitializationSelection,
  database: ReturnType<typeof toDatabaseOptions>,
  source?: DatabasePathIdentity,
): Promise<Record<string, SessionEntry>> {
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  const memory = captureMemoryExactSessionReader(params);
  if (memory) {
    const entries: Record<string, SessionEntry> = {};
    const currentKey = normalizeStoreSessionKey(params.sessionKey);
    const keys = new Set([currentKey, ...(params.relatedSessionKeys ?? [])]);
    for (const key of keys) {
      const sessionKey = normalizeStoreSessionKey(key);
      const entry = memory.read(sessionKey);
      if (entry) {
        entries[sessionKey] = entry;
        if (sessionKey === currentKey && entry.parentSessionKey) {
          keys.add(entry.parentSessionKey);
        }
      }
    }
    return entries;
  }
  if (!supportsOpenClawAgentDatabaseExecution(database)) {
    return loadReplySessionInitializationEntriesForMaintenance(params);
  }
  return withSessionHistoryWorkerDatabase(database, async (reader) => {
    const currentKey = normalizeStoreSessionKey(params.sessionKey);
    const snapshot = await reader.readExactEntries({
      projection: "full",
      includeAuthorization: true,
      sessionKeys: [
        ...new Set([
          currentKey,
          ...(params.relatedSessionKeys ?? []).map(normalizeStoreSessionKey),
        ]),
      ],
      replyInitializationSessionKey: currentKey,
      env: { ...(database.env ?? process.env) },
    });
    reader.assertCurrent();
    if (
      source &&
      (snapshot.databaseIdentity
        ? `file:${snapshot.databaseIdentity.identity}` !== source.key ||
          snapshot.databaseIdentity.birthtime !== source.birthtime
        : source.key.startsWith("file:"))
    ) {
      throw new Error("Reply initialization database changed after its snapshot");
    }
    return Object.fromEntries(snapshot.entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
  });
}

export function captureReplySessionInitializationSource(
  params: ReplySessionInitializationSelection & { databaseSource?: DatabasePathIdentity },
) {
  const captured = captureLifecycleDatabaseScope(resolveSqliteScope(params));
  const source =
    params.databaseSource ??
    (supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(captured))
      ? readDatabasePathIdentitySync(captured.path)
      : undefined);
  const database = { ...toDatabaseOptions(captured), path: source?.canonicalPath ?? captured.path };
  const assertSourceCurrent = (creating = false) => {
    if (!source) {
      return;
    }
    const current = readDatabasePathIdentitySync(captured.path);
    if (
      current.canonicalPath !== source.canonicalPath ||
      ((!creating || source.key.startsWith("file:")) &&
        (current.key !== source.key || current.birthtime !== source.birthtime))
    ) {
      throw new Error("Reply initialization database changed after its snapshot");
    }
  };
  return { captured, database, source, assertSourceCurrent };
}

/** Prepares data for initialization; the commit owner still rereads and checks its revision. */
export async function loadReplySessionInitializationSnapshot(
  params: ReplySessionInitializationSelection,
  options: {
    reader?: SessionEntryCohortReader;
    includeLifecycle?: boolean;
    includeColdMetadata?: boolean;
    assertCurrent?: () => void;
  } = {},
): Promise<
  ReplySessionInitializationSnapshot & {
    databaseSource?: DatabasePathIdentity;
    lifecycleTimestamps?: SessionLifecycleTimestamps;
    coldArchives?: Array<Omit<SessionColdArchive, "archive_blob">>;
  }
> {
  const { reader, includeLifecycle = false, assertCurrent = () => {} } = options;
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  assertCurrent();
  const storePath = resolveSessionStorePathForScope(params);
  let store: Record<string, SessionEntry>;
  let databaseSource: DatabasePathIdentity | undefined;
  let lifecycleTimestamps: SessionLifecycleTimestamps | undefined;
  let coldArchives: Array<Omit<SessionColdArchive, "archive_blob">> | undefined;
  if (reader) {
    const sessionKey = assertSessionEntryCohortScope(reader, { ...params, storePath });
    const prepared = await reader.withRead(
      {
        sessionKeys: [
          ...new Set([
            sessionKey,
            ...(params.relatedSessionKeys ?? []).map(normalizeStoreSessionKey),
          ]),
        ],
        replyInitializationSessionKey: sessionKey,
        ...(options.includeColdMetadata ? { includeColdMetadata: true } : {}),
        ...(includeLifecycle ? { lifecycleSessionKey: sessionKey } : {}),
      },
      assertCurrent,
      (read) => ({
        store: Object.fromEntries(read.entries.map(({ sessionKey: key, entry }) => [key, entry])),
        lifecycleTimestamps: includeLifecycle ? read.lifecycleTimestamps : undefined,
        coldArchives: read.coldArchives,
      }),
    );
    store = prepared.store;
    lifecycleTimestamps = prepared.lifecycleTimestamps;
    coldArchives = prepared.coldArchives;
  } else {
    const { database, source } = captureReplySessionInitializationSource({
      ...params,
      storePath,
    });
    databaseSource = source;
    store = await loadReplySessionInitializationEntriesAsync(
      { ...params, storePath },
      database,
      source,
    );
  }
  assertCurrent();
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  return {
    ...(currentEntry ? { currentEntry } : {}),
    readEntry: (sessionKey) => {
      const entry = resolveSessionEntryFromStore({ store, sessionKey }).existing;
      return entry ? { ...entry } : undefined;
    },
    revision: createReplySessionInitializationRevision(currentEntry),
    ...(databaseSource ? { databaseSource } : {}),
    ...(lifecycleTimestamps ? { lifecycleTimestamps } : {}),
    ...(coldArchives ? { coldArchives } : {}),
  };
}
