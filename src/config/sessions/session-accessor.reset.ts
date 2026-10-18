import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { clearAllCliSessions } from "./cli-session-binding.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import {
  cloneSessionEntries,
  createReplySessionInitializationRevision,
} from "./session-accessor.entry-mutation.js";
import { resolveSessionEntryFromStore } from "./session-accessor.entry.js";
import type {
  SessionEntryLifecycleUpsert,
  SessionResetBoundaryWrite,
} from "./session-accessor.lifecycle-types.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import { withSessionEntryCreationPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import type { SessionEntryCreationOperation } from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  ReplySessionInitializationSnapshot,
  ReplySessionInitializationCommitContext,
  ReplySessionInitializationCommitResult,
} from "./session-accessor.types.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";
import { admitSessionConversationBranch } from "./session-conversation-admission.js";
import { assertSessionEntryCohortScope } from "./session-entry-cohort-scope.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import type { PreparedInitialSessionContext } from "./session-initial-context.js";
import {
  SessionEntryLifecycleUpsertConflictError,
  SessionMaintenancePreservationConflictError,
} from "./session-mutation-conflict-error.js";
import { resolveReplySessionInitializationUpserts } from "./session-reset-entry.js";
import type { ReplySessionInitializationUpsertDescriptor } from "./session-reset.types.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionEntryRetirement = {
  entry: SessionEntry;
  key: string;
};

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

function assertSessionInitializationAgentScope(agentId: string, sessionKey: string): void {
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

function loadReplySessionInitializationEntries(
  params: ReplySessionInitializationSelection,
): Record<string, SessionEntry> {
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(database.db, () => {
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

async function loadReplySessionInitializationEntriesAsync(
  params: ReplySessionInitializationSelection,
  database: ReturnType<typeof toDatabaseOptions>,
  source?: DatabasePathIdentity,
): Promise<Record<string, SessionEntry>> {
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  if (!supportsOpenClawAgentDatabaseExecution(database)) {
    return loadReplySessionInitializationEntries(params);
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

function captureReplySessionInitializationSource(params: ReplySessionInitializationSelection) {
  const captured = captureLifecycleDatabaseScope(resolveSqliteScope(params));
  const source = supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(captured))
    ? readDatabasePathIdentitySync(captured.path)
    : undefined;
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
    lifecycleTimestamps?: SessionLifecycleTimestamps;
    coldArchives?: Array<Omit<SessionColdArchive, "archive_blob">>;
  }
> {
  const { reader, includeLifecycle = false, assertCurrent = () => {} } = options;
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  assertCurrent();
  const storePath = resolveSessionStorePathForScope(params);
  let store: Record<string, SessionEntry>;
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
    const { database, source, assertSourceCurrent } = captureReplySessionInitializationSource({
      ...params,
      storePath,
    });
    store = await loadReplySessionInitializationEntriesAsync(
      { ...params, storePath },
      database,
      source,
    );
    assertSourceCurrent();
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
    ...(lifecycleTimestamps ? { lifecycleTimestamps } : {}),
    ...(coldArchives ? { coldArchives } : {}),
  };
}

function createStaleReplySessionInitializationResult(
  currentEntry: SessionEntry | undefined,
): ReplySessionInitializationCommitResult {
  return {
    ok: false,
    ...(currentEntry ? { currentEntry } : {}),
    reason: "stale-snapshot",
    revision: createReplySessionInitializationRevision(currentEntry),
  };
}

/** Persists one reply-session initialization result with its in-place reset boundary. */
export async function commitReplySessionInitialization(params: {
  bindCreation?: (operation: SessionEntryCreationOperation) => () => void;
  commitGuard?: () => void;
  /** Source read authorization retains its prepared worker predicates separately from live guards. */
  contextSourceAuthority?: SessionSourceAssertion;
  /** Host-selected canonical headless root; never supplied by a model or transport payload. */
  branchRootSessionKey?: string;
  activeSessionKey: string;
  agentId: string;
  beforeEntryMutation?: (context: {
    currentEntry?: SessionEntry;
    sessionEntry: SessionEntry;
  }) => Promise<void> | void;
  expectedRevision: string;
  /** Native-prepared copied context, never an authority or parent/spawn relationship. */
  initialContext?: PreparedInitialSessionContext;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  prepareSessionEntry?: (
    context: ReplySessionInitializationCommitContext,
  ) => Promise<SessionEntry> | SessionEntry;
  /** Authoritative contextual route facts observed by the admitted inbound turn. */
  routeContext?: ConversationRouteContext | null;
  resetBoundary?: SessionResetBoundaryWrite;
  previousEntry?: SessionEntry;
  retiredEntry?: SessionEntryRetirement;
  sessionEntry: SessionEntry;
  sessionKey: string;
  relatedSessionKeys?: readonly string[];
  snapshotEntry?: SessionEntry;
  storePath: string;
}): Promise<ReplySessionInitializationCommitResult> {
  const branchRootSessionKey = params.branchRootSessionKey;
  const initialContext = params.initialContext ? structuredClone(params.initialContext) : undefined;
  if (initialContext) {
    if (!params.contextSourceAuthority?.prepareSessionSource) {
      throw new Error("Initial conversation context requires retained source authority.");
    }
    params.contextSourceAuthority();
  }
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  const storePath = resolveSessionStorePathForScope({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  const { captured, database, source, assertSourceCurrent } =
    captureReplySessionInitializationSource({
      ...params,
      storePath,
    });
  const store = await loadReplySessionInitializationEntriesAsync(
    {
      ...params,
      storePath,
      relatedSessionKeys: [
        ...(params.relatedSessionKeys ?? []),
        ...(branchRootSessionKey ? [branchRootSessionKey] : []),
      ],
    },
    database,
    source,
  );
  assertSourceCurrent();
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  const revision = createReplySessionInitializationRevision(currentEntry);
  if (revision !== params.expectedRevision) {
    return createStaleReplySessionInitializationResult(currentEntry);
  }

  const readEntry = (sessionKey: string) => {
    const entry = resolveSessionEntryFromStore({ store, sessionKey }).existing;
    return entry ? { ...entry } : undefined;
  };
  const rootKey = branchRootSessionKey;
  const topology = rootKey
    ? admitSessionConversationBranch({
        agentId: params.agentId,
        sessionKey: resolved.normalizedKey,
        currentEntry,
        rootSessionKey: rootKey,
        rootEntry: readEntry(rootKey),
      })
    : undefined;
  if (topology) {
    if (!source?.key.startsWith("file:")) {
      throw new Error("Conversation membership requires an admitted durable root source.");
    }
  }
  if (
    initialContext &&
    (currentEntry || params.previousEntry || params.retiredEntry || params.resetBoundary)
  ) {
    throw new Error("Initial conversation context cannot replace an existing session.");
  }
  let sessionEntry = params.prepareSessionEntry
    ? await params.prepareSessionEntry({
        ...(currentEntry ? { currentEntry } : {}),
        readEntry,
        sessionEntry: params.sessionEntry,
      })
    : params.sessionEntry;
  if (topology) {
    sessionEntry = { ...sessionEntry, conversationTopology: topology };
  }
  if (initialContext) {
    sessionEntry = {
      ...sessionEntry,
      forkSource: {
        sessionKey: normalizeStoreSessionKey(initialContext.sourceSessionKey),
        sessionId: initialContext.sourceEntry.sessionId,
        ...(initialContext.sourceThrough ? { entryId: initialContext.sourceThrough.entryId } : {}),
      },
      // A copied transcript is not the empty context computed by normal creation.
      totalTokens: undefined,
      totalTokensFresh: false,
      totalTokensVersion: undefined,
    };
    // A backend checkpoint can contain more history than the accepted snapshot.
    clearAllCliSessions(sessionEntry);
  }
  let staleCommit: SessionEntry | null | undefined;
  let committedSessionEntry = sessionEntry;
  let beforeEntryMutationDone = false;
  const descriptor: ReplySessionInitializationUpsertDescriptor = {
    kind: "reply-initialization",
    expectedRevision: params.expectedRevision,
    entry: sessionEntry,
    snapshotEntry: params.snapshotEntry ?? params.previousEntry,
    retiredEntry: params.retiredEntry,
  };
  let preparedUpserts: ReturnType<typeof resolveReplySessionInitializationUpserts> | undefined;
  const upserts: SessionEntryLifecycleUpsert[] = [
    {
      sessionKey: resolved.normalizedKey,
      ...(topology ? { conversationBranchAdmission: topology } : {}),
      ...(initialContext ? { initialContext } : {}),
      ...(params.routeContext !== undefined ? { routeContext: params.routeContext } : {}),
      ...(params.resetBoundary ? { resetBoundary: params.resetBoundary } : {}),
      buildEntry: async ({ currentEntry: commitEntry }) => {
        preparedUpserts = resolveReplySessionInitializationUpserts(descriptor, commitEntry);
        if (preparedUpserts.kind === "stale") {
          staleCommit = preparedUpserts.currentEntry ? { ...preparedUpserts.currentEntry } : null;
          return null;
        }
        committedSessionEntry = preparedUpserts.entry;
        if (!beforeEntryMutationDone) {
          await params.beforeEntryMutation?.({
            ...(commitEntry ? { currentEntry: { ...commitEntry } } : {}),
            sessionEntry: committedSessionEntry,
          });
          beforeEntryMutationDone = true;
        }
        return committedSessionEntry;
      },
    },
  ];
  if (params.retiredEntry) {
    const retiredEntry = params.retiredEntry;
    upserts.push({
      sessionKey: retiredEntry.key,
      buildEntry: () =>
        preparedUpserts?.kind === "ready" ? (preparedUpserts.retiredEntry?.entry ?? null) : null,
    });
  }
  try {
    assertSourceCurrent();
    const mutation = {
      activeSessionKey: params.activeSessionKey,
      agentId: params.agentId,
      maintenanceOverride: params.maintenanceConfig,
      storePath,
      upserts,
      ...(params.contextSourceAuthority ? { source: params.contextSourceAuthority } : {}),
      commitGuard: () => {
        assertSourceCurrent(true);
        params.commitGuard?.();
      },
    };
    const bindCreation = params.bindCreation;
    if (bindCreation) {
      if (currentEntry || !source?.key.startsWith("file:")) {
        throw new Error("The original absent session no longer has its prepared creation source");
      }
      await withSessionEntryCreationPublication(
        {
          agentId: params.agentId,
          sessionKey: resolved.normalizedKey,
          file: {
            path: database.path,
            agentId: captured.agentId,
            databaseIdentity: source.key.slice("file:".length),
            assertCurrent: assertSourceCurrent,
          },
        },
        async (operation) => {
          const assertCreationCurrent = bindCreation(operation);
          await applySessionEntryLifecycleMutation(
            {
              ...mutation,
              commitGuard: () => {
                mutation.commitGuard();
                assertCreationCurrent();
              },
            },
            { ...captured, path: database.path },
          );
        },
      );
    } else {
      await applySessionEntryLifecycleMutation(mutation, { ...captured, path: database.path });
    }
  } catch (error) {
    if (
      !(error instanceof SessionMaintenancePreservationConflictError) &&
      (!(error instanceof SessionEntryLifecycleUpsertConflictError) ||
        error.sessionKey !== resolved.normalizedKey)
    ) {
      throw error;
    }
    const current = await loadReplySessionInitializationEntriesAsync(
      {
        agentId: params.agentId,
        sessionKey: resolved.normalizedKey,
        storePath,
      },
      database,
      source?.key.startsWith("file:") ? source : undefined,
    );
    assertSourceCurrent(true);
    return createStaleReplySessionInitializationResult(current[resolved.normalizedKey]);
  }
  if (staleCommit !== undefined) {
    return createStaleReplySessionInitializationResult(staleCommit ?? undefined);
  }
  store[resolved.normalizedKey] = committedSessionEntry;
  if (params.retiredEntry) {
    store[params.retiredEntry.key] = params.retiredEntry.entry;
  }
  return {
    ok: true,
    sessionEntry: { ...committedSessionEntry },
    sessionStoreView: cloneSessionEntries(store),
  };
}
