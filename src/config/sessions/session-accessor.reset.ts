import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { clearAllCliSessions } from "./cli-session-binding.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import { createReplySessionInitializationRevision } from "./session-accessor.entry-mutation.js";
import { resolveSessionEntryFromStore } from "./session-accessor.entry.js";
import type {
  SessionEntryLifecycleUpsert,
  SessionResetBoundaryWrite,
} from "./session-accessor.lifecycle-types.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import { withSessionEntryCreationPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import type { SessionEntryCreationOperation } from "./session-accessor.sqlite-entry-cache.types.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import { resolveSqliteTranscriptArchiveDirectory } from "./session-accessor.sqlite-scope.js";
import type {
  ReplySessionInitializationCommitContext,
  ReplySessionInitializationCommitResult,
} from "./session-accessor.types.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { admitSessionConversationBranch } from "./session-conversation-admission.js";
import type { SessionEntryCreationCommit } from "./session-entry-creation.types.js";
import type { PreparedInitialSessionContext } from "./session-initial-context.js";
import {
  SessionEntryLifecycleUpsertConflictError,
  SqliteSessionMutationConflictError,
} from "./session-mutation-conflict-error.js";
import {
  createStaleReplySessionInitializationResult,
  resolveReplySessionInitializationUpserts,
} from "./session-reset-entry.js";
import {
  assertSessionInitializationAgentScope,
  captureReplySessionInitializationSource,
  loadReplySessionInitializationEntriesAsync,
} from "./session-reset-preparation.js";
import type { ReplySessionInitializationUpsertDescriptor } from "./session-reset.types.js";
import {
  composeSessionSourceAssertion,
  releaseSessionSourceAuthorities,
  type SessionSourceAssertion,
  type SessionSourceTransactionGrant,
} from "./session-source-authority.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionEntryRetirement = {
  entry: SessionEntry;
  key: string;
};

/** Live preparation is owned by its caller until the native creation settles. */
export type PreparedReplySessionInitialContext = {
  context: PreparedInitialSessionContext;
  source: SessionSourceAssertion;
  assertEntry: (entry: SessionEntry) => void;
  bindCreation: (operation: SessionEntryCreationOperation) => () => void;
  release: () => void | Promise<void>;
};

/** Persists one reply-session initialization result with its in-place reset boundary. */
export async function commitReplySessionInitialization(params: {
  creationSource?: SessionSourceTransactionGrant;
  /** Keep an authorized creation bound to the database read by its snapshot. */
  databaseSource?: DatabasePathIdentity;
  bindCreation?: (operation: SessionEntryCreationOperation) => () => void;
  onCreated?: (created: SessionEntryCreationCommit) => void;
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
  /** Runs only for true creation, after the final row and root admission are known. */
  prepareInitialContext?: (
    entry: SessionEntry,
  ) => Promise<PreparedReplySessionInitialContext | undefined>;
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
  let initialContext = params.initialContext ? structuredClone(params.initialContext) : undefined;
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
  const sessionKey = normalizeStoreSessionKey(params.sessionKey);
  const needsPreparationSnapshot = Boolean(
    params.prepareSessionEntry ||
    params.bindCreation ||
    branchRootSessionKey ||
    initialContext ||
    params.prepareInitialContext,
  );
  let store: Record<string, SessionEntry> = {};
  let currentEntry: SessionEntry | undefined;
  let sessionEntry = params.sessionEntry;
  if (needsPreparationSnapshot) {
    // Parent-fork preparation can append transcripts; creation binds live authority.
    // Both need their snapshot before lifecycle planning starts.
    store = await measureDiagnosticsTimelineSpan("reply.session.commit.fresh_read", () =>
      loadReplySessionInitializationEntriesAsync(
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
      ),
    );
    currentEntry = store[sessionKey] ? { ...store[sessionKey] } : undefined;
    if (createReplySessionInitializationRevision(currentEntry) !== params.expectedRevision) {
      return createStaleReplySessionInitializationResult(currentEntry);
    }
    if (params.prepareSessionEntry) {
      sessionEntry = await params.prepareSessionEntry({
        ...(currentEntry ? { currentEntry } : {}),
        readEntry: (key) => {
          const entry = resolveSessionEntryFromStore({ store, sessionKey: key }).existing;
          return entry ? { ...entry } : undefined;
        },
        sessionEntry,
      });
    }
  }
  const topology = branchRootSessionKey
    ? admitSessionConversationBranch({
        agentId: params.agentId,
        sessionKey,
        currentEntry,
        rootSessionKey: branchRootSessionKey,
        rootEntry: store[normalizeStoreSessionKey(branchRootSessionKey)],
      })
    : undefined;
  if (topology && !source?.key.startsWith("file:")) {
    throw new Error("Conversation membership requires an admitted durable root source.");
  }
  if (
    initialContext &&
    (currentEntry || params.previousEntry || params.retiredEntry || params.resetBoundary)
  ) {
    throw new Error("Initial conversation context cannot replace an existing session.");
  }
  if (topology) {
    sessionEntry = { ...sessionEntry, conversationTopology: topology };
  }
  const preparedContext =
    !initialContext &&
    !currentEntry &&
    !params.previousEntry &&
    !params.retiredEntry &&
    !params.resetBoundary
      ? await params.prepareInitialContext?.(structuredClone(sessionEntry))
      : undefined;
  const preparationErrors: unknown[] = [];
  try {
    if (preparedContext) {
      if (!preparedContext.source.prepareSessionSource) {
        throw new Error("Initial conversation context requires retained source authority.");
      }
      preparedContext.source();
      initialContext = structuredClone(preparedContext.context);
    }
    const contextSourceAuthority = preparedContext
      ? composeSessionSourceAssertion([params.contextSourceAuthority, preparedContext.source])
      : params.contextSourceAuthority;
    if (initialContext) {
      sessionEntry = {
        ...sessionEntry,
        ...(initialContext.kind !== "root-projection" &&
        initialContext.kind !== "prepared-root-projection"
          ? {
              forkSource: {
                sessionKey: normalizeStoreSessionKey(initialContext.sourceSessionKey),
                sessionId: initialContext.sourceEntry.sessionId,
                ...(initialContext.sourceThrough
                  ? { entryId: initialContext.sourceThrough.entryId }
                  : {}),
              },
            }
          : {}),
        totalTokens: undefined,
        totalTokensFresh: false,
        totalTokensVersion: undefined,
      };
      clearAllCliSessions(sessionEntry);
    }
    let staleCommit: SessionEntry | null | undefined;
    let usedMemoryBackend = false;
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
    const buildEntry = async (
      commitEntry: SessionEntry | undefined,
      readEntry: (key: string) => SessionEntry | undefined,
    ) => {
      if (!needsPreparationSnapshot) {
        for (const key of [
          sessionKey,
          ...(params.relatedSessionKeys ?? []),
          commitEntry?.parentSessionKey,
        ]) {
          if (!key) {
            continue;
          }
          const entry = readEntry(key);
          if (entry) {
            store[normalizeStoreSessionKey(key)] = entry;
          }
        }
      }
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
      preparedContext?.assertEntry(committedSessionEntry);
      return committedSessionEntry;
    };
    const upserts: SessionEntryLifecycleUpsert[] = [
      {
        sessionKey,
        ...(topology ? { conversationBranchAdmission: topology } : {}),
        ...(initialContext ? { initialContext } : {}),
        ...(!needsPreparationSnapshot
          ? { relatedSessionKeys: params.relatedSessionKeys ?? [] }
          : {}),
        ...(params.routeContext !== undefined ? { routeContext: params.routeContext } : {}),
        ...(params.resetBoundary ? { resetBoundary: params.resetBoundary } : {}),
        buildEntry: ({ currentEntry: commitEntry, readEntry }) =>
          buildEntry(commitEntry, readEntry),
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
      const mutation = {
        creationSource: params.creationSource,
        activeSessionKey: params.activeSessionKey,
        agentId: params.agentId,
        skipMaintenance: true,
        ...(contextSourceAuthority ? { source: contextSourceAuthority } : {}),
        storePath,
        upserts,
        commitGuard: () => {
          assertSourceCurrent(true);
          params.commitGuard?.();
        },
      };
      const mutate = async () => {
        const bindCreation =
          params.bindCreation || preparedContext
            ? (operation: SessionEntryCreationOperation) => {
                const original = params.bindCreation?.(operation);
                const prepared = preparedContext?.bindCreation(operation);
                return () => {
                  original?.();
                  prepared?.();
                };
              }
            : undefined;
        const assertCurrent = () => params.commitGuard?.();
        const memoryMutation = await withSessionActorStorage(
          { ...params, storePath },
          {
            authority: { assertCurrent, authorize: assertCurrent },
            lifetime: { assertCurrent, assertReadable: assertCurrent },
            create: true,
          },
          async (memory) => {
            if (initialContext || topology) {
              throw new Error(
                "Durable conversation context cannot be copied into an incognito actor",
              );
            }
            const readEntry = (key: string) =>
              memory.actor.storage.readCurrent(
                {
                  type: "session.entry.read",
                  input: { sessionKey: normalizeStoreSessionKey(key) },
                },
                memory.authority,
              );
            if (!needsPreparationSnapshot) {
              currentEntry = readEntry(sessionKey);
            }
            const nextEntry = await buildEntry(currentEntry, (key) =>
              normalizeStoreSessionKey(key) === sessionKey ? currentEntry : readEntry(key),
            );
            if (!nextEntry) {
              return true;
            }
            const commit = async (assertCreationCurrent?: () => void) => {
              const result = readSessionActorStorageResult(
                await memory.actor.storage.mutate(
                  {
                    type: "session.lifecycle.reset",
                    input: {
                      expected: currentEntry,
                      nextEntry,
                      routeContext: params.routeContext,
                      resetBoundary: params.resetBoundary,
                      ...(params.retiredEntry
                        ? {
                            relatedReplacements: [
                              {
                                sessionKey: params.retiredEntry.key,
                                expected: store[params.retiredEntry.key],
                                entry: params.retiredEntry.entry,
                              },
                            ],
                          }
                        : {}),
                    },
                  },
                  {
                    ...memory.authority,
                    assertCurrent() {
                      memory.authority.assertCurrent();
                      assertCreationCurrent?.();
                    },
                  },
                ),
              );
              committedSessionEntry = result.nextEntry;
            };
            if (bindCreation) {
              await withSessionEntryCreationPublication(
                {
                  agentId: memory.agentId,
                  sessionKey,
                  file: {
                    kind: "actor",
                    path: memory.path,
                    agentId: memory.agentId,
                    databaseIdentity: memory.actor.target.database.incarnation,
                    assertCurrent: () => memory.actor.assertCurrent(),
                  },
                },
                (operation) => commit(bindCreation(operation)),
              );
            } else {
              await commit();
            }
            return true;
          },
        );
        if (memoryMutation) {
          usedMemoryBackend = true;
          return;
        }
        if (bindCreation) {
          if (currentEntry || !source?.key.startsWith("file:")) {
            throw new Error(
              "The original absent session no longer has its prepared creation source",
            );
          }
          await withSessionEntryCreationPublication(
            {
              agentId: params.agentId,
              sessionKey,
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
              if (staleCommit === undefined) {
                params.onCreated?.({
                  agentId: params.agentId,
                  sessionKey,
                  storePath,
                  sessionId: committedSessionEntry.sessionId,
                  lifecycleRevision: committedSessionEntry.lifecycleRevision,
                  readSource: {
                    agentId: captured.agentId,
                    path: database.path,
                    databaseIdentity: source.key.slice("file:".length),
                    databaseBirthtime: source.birthtime,
                  },
                  entry: committedSessionEntry,
                });
              }
            },
          );
        } else {
          await applySessionEntryLifecycleMutation(mutation, { ...captured, path: database.path });
        }
      };
      await measureDiagnosticsTimelineSpan("reply.session.commit.mutation", mutate);
    } catch (error) {
      if (
        !(
          error instanceof SqliteSessionMutationConflictError &&
          error.operationLabel === "session.lifecycle.reset"
        ) &&
        (!(error instanceof SessionEntryLifecycleUpsertConflictError) ||
          error.sessionKey !== sessionKey)
      ) {
        throw error;
      }
      const current = await loadReplySessionInitializationEntriesAsync(
        {
          agentId: params.agentId,
          sessionKey,
          storePath,
        },
        database,
        source?.key.startsWith("file:") ? source : undefined,
      );
      return createStaleReplySessionInitializationResult(current[sessionKey]);
    }
    if (staleCommit !== undefined) {
      return createStaleReplySessionInitializationResult(staleCommit ?? undefined);
    }
    if (!usedMemoryBackend) {
      // Reply preparation shares ordinary writes' maintenance owner, never forced cleanup.
      kickSessionEntryMaintenanceAfterWrite({
        activeSessionKey: params.activeSessionKey,
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(captured),
        maintenanceConfig: params.maintenanceConfig,
        scope: { ...captured, path: database.path },
        storePath,
      });
    }
    store[sessionKey] = committedSessionEntry;
    if (params.retiredEntry) {
      store[params.retiredEntry.key] = params.retiredEntry.entry;
    }
    return {
      ok: true,
      sessionEntry: { ...committedSessionEntry },
      sessionStoreView: Object.fromEntries(
        Object.entries(store).map(([key, entry]) => [key, { ...entry }]),
      ),
    };
  } catch (error) {
    preparationErrors.push(error);
    throw error;
  } finally {
    if (preparedContext) {
      await releaseSessionSourceAuthorities([preparedContext], preparationErrors);
    }
  }
}

export {
  SessionInitializationAgentScopeMismatchError,
  loadReplySessionInitializationSnapshot,
} from "./session-reset-preparation.js";
