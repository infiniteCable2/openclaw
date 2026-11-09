import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, type Result } from "@openclaw/normalization-core/result";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import {
  getCliHistoryWriter,
  cliHistoryWriterFacts,
  answerCliHistoryOwnerProbe,
} from "./cli-history-boundary.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryWorkerMetadataInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { publishCommittedTranscriptUpdate } from "./session-accessor.sqlite-events.js";
import { prepareSessionEntryReplacementDatabase } from "./session-accessor.sqlite-replacement-worker.js";
import {
  captureLifecycleDatabaseScope,
  assertSqliteTranscriptWriteIdentity,
  prepareSqliteScope,
  resolveSqliteScope,
  resolveSqliteWriteAdmissionScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  TranscriptReportCommit,
  TranscriptReportWorkerOperations,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import type { TranscriptReportWorkerTarget } from "./session-accessor.sqlite-transcript-reports.worker.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import {
  captureSessionActorStorageOwner,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import { withMemoryReportWorker } from "./session-actor-transcript-reports.js";
import { assertSessionEntryCurrentAdmission } from "./session-entry-current-admission.js";
import type { SessionEntryCurrentCheck } from "./session-entry-current.types.js";
import {
  acceptSessionSourceValidation,
  prepareSessionSourceAuthority,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
  type SessionSourceValidation,
} from "./session-source-authority.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { settleReportOperation } from "./session-transcript-report-settlement.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

export type IncognitoTranscriptReportBinding = SessionActorStorageBinding;

export async function withReportWorker<T>(
  scope: SessionTranscriptWriteScope,
  kind: "read" | "append",
  run: (
    operation: Pick<SqliteWorkerStore<TranscriptReportWorkerOperations>, "execute">,
    assertCurrent: () => void,
    publish: (result: TranscriptReportCommit) => void,
  ) => Promise<Result<T, TranscriptAppendRefusal>>,
  sessionEntryCurrent?: SessionEntryCurrentCheck,
  incognito?: IncognitoTranscriptReportBinding,
  sourceAssertion?: SessionSourceAssertion,
): Promise<Result<T, TranscriptAppendRefusal>> {
  const memoryScope = incognito ? { ...scope, sessionActor: incognito } : scope;
  const assertCaller = captureOwnedTranscriptWriteAssertion(memoryScope);
  const authority = { assertCurrent: assertCaller, authorize: assertCaller };
  const namespace = captureSessionActorStorageOwner(memoryScope, authority);
  if (namespace) {
    if (sourceAssertion || sessionEntryCurrent) {
      throw new Error("A file session source cannot authorize a memory transcript report");
    }
    const result = await withSessionActorStorage(
      memoryScope,
      {
        authority,
        lifetime: { assertCurrent: assertCaller, assertReadable: assertCaller },
      },
      (memory) => withMemoryReportWorker(scope, memory, run),
    );
    if (result) {
      return result;
    }
    const refusal = resolveTranscriptAppendRefusal(
      undefined,
      {
        agentId: namespace.agentId,
        path: namespace.path,
        sessionKey: scope.sessionKey ?? "",
        sessionId: scope.sessionId ?? "",
      },
      scope,
    )!;
    if (scope.expectedWriterRunId !== undefined) {
      throw new SessionTranscriptWriterClaimReboundError(refusal);
    }
    return err(refusal);
  }
  // Preserve the logical target for live authority and pin the physical owner before yielding.
  const fenced = withOwnedSessionTranscriptWriterFence({
    ...scope,
    ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  });
  const assertOwned = captureOwnedTranscriptWriteAssertion(fenced);
  assertSqliteTranscriptWriteIdentity(fenced);
  assertOwned();
  const source = sessionEntryCurrent?.source;
  const storePath =
    fenced.storePath ??
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteScope(fenced)));
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const sourceIdentity = source ? readDatabasePathIdentitySync(source.path) : undefined;
  const assertSourceCurrent = () => {
    if (!source) {
      return;
    }
    assertExistingDatabaseIdentity(
      source.path,
      `file:${source.databaseIdentity}`,
      source.databaseBirthtime,
    );
  };
  assertSourceCurrent();
  const targetScope = { ...fenced, storePath };
  const admission = resolveSqliteWriteAdmissionScope(targetScope);
  let composedSource: PreparedSessionSourceAuthority | undefined;
  const prepare = async () => {
    const resolved = captureLifecycleDatabaseScope({
      ...(await prepareSqliteScope(targetScope)),
      sessionId: fenced.sessionId,
    });
    if (admission && resolved.path !== admission.path) {
      throw new Error("Transcript report preparation changed its reserved database path");
    }
    const databaseOptions = toDatabaseOptions(resolved);
    const options = { ...databaseOptions, path: resolveOpenClawAgentSqlitePath(databaseOptions) };
    const physicalPath = assertSessionStoreReadCandidate(options.path, candidates);
    if (
      source &&
      (resolved.sessionKey !== source.sessionKey ||
        databaseOptions.agentId !== source.agentId ||
        physicalPath !== sourceIdentity?.canonicalPath)
    ) {
      throw new Error("Transcript report target differs from its session source restriction");
    }
    const identity = identities.get(physicalPath) ?? readDatabasePathIdentitySync(options.path);
    if (!identities.has(physicalPath) && identity.key.startsWith("file:")) {
      throw new Error("Transcript report target appeared after source capture");
    }
    const assertTargetCurrent = () => {
      assertSourceCurrent();
      assertSessionStoreReadCandidate(options.path, candidates);
      if (identity.key.startsWith("file:")) {
        assertExistingDatabaseIdentity(options.path, identity.key, identity.birthtime);
      }
      assertOwned();
      (composedSource?.assertPreparedCurrent ?? composedSource?.assertCurrent)?.();
    };
    assertTargetCurrent();
    const operate = async () => {
      assertTargetCurrent();
      const execution = captureOpenClawAgentDatabaseExecution(
        options,
        identity.key.startsWith("file:")
          ? {
              expectedIdentity: {
                kind: "file",
                physicalIdentity: identity.key.slice("file:".length),
                nativeLocation: identity.canonicalPath,
                birthtime: identity.birthtime,
              },
            }
          : { expectedCreationIdentity: identity },
      );
      const cliWriter =
        kind === "append"
          ? getCliHistoryWriter({ ...resolved, storePath: resolveOpenClawAgentSqlitePath(options) })
          : undefined;
      const assertCurrent = () => {
        execution.assertCurrent();
        assertTargetCurrent();
        cliWriter?.assertCurrent();
      };
      const { env: _env, ...workerResolved } = resolved;
      const target: TranscriptReportWorkerTarget = {
        resolved: workerResolved,
        sessionEntryCurrentSource: sessionEntryCurrent?.source,
        ...(composedSource
          ? {
              sourcePredicates: structuredClone(
                composedSource.checks.map(({ predicate }) => predicate),
              ),
            }
          : {}),
        ...(cliWriter
          ? {
              cliWriter: cliHistoryWriterFacts(cliWriter),
            }
          : {}),
        fence: {
          expectedLifecycleRevision: fenced.expectedLifecycleRevision,
          expectedWriterRunId: fenced.expectedWriterRunId,
        },
      };
      try {
        const result = await settleReportOperation(
          async () => {
            await prepareSessionEntryReplacementDatabase(options, assertCurrent, execution);
            assertCurrent();
            const databaseIdentity = execution.fileIdentity?.physicalIdentity;
            if (!databaseIdentity) {
              throw new Error("Transcript report has no prepared native database identity");
            }
            const worker =
              await openOpenClawAgentSqliteWorkerStore<TranscriptReportWorkerOperations>(
                options,
                { execution },
                {
                  moduleUrl: resolveRuntimeWorkerUrl(
                    runtimeProcessEntrypoints.sessionTranscriptReports,
                  ),
                  input: target,
                  assertAdmission: (request) => {
                    if (request.stage !== "transaction" && request.stage !== "commit") {
                      return request;
                    }
                    const admitted = assertSessionEntryCurrentAdmission(
                      request,
                      sessionEntryCurrent,
                    );
                    if (composedSource) {
                      if (
                        !isRecord(admitted.facts) ||
                        !isRecord(admitted.facts.reportSourceValidation)
                      ) {
                        throw new Error("Transcript report omitted its composed source validation");
                      }
                      acceptSessionSourceValidation(
                        composedSource,
                        // SAFETY: This pinned report worker publishes readSessionSourceValidation's return value.
                        admitted.facts.reportSourceValidation as SessionSourceValidation,
                      );
                      composedSource.assertCurrent();
                    }
                    answerCliHistoryOwnerProbe(
                      isRecord(admitted.facts) ? admitted.facts.publication : undefined,
                      cliWriter,
                    );
                    return admitted;
                  },
                },
              );
            return settleReportOperation(
              () =>
                worker.run(
                  (operation) =>
                    run(operation, assertCurrent, (publication) => {
                      assertCurrent();
                      if (publication.cliHistoryChanged || publication.sessionEntryChanged) {
                        publishSessionEntryWorkerMetadataInvalidation({
                          agentId: resolved.agentId,
                          storePath: execution.path,
                          databaseIdentity,
                          sessionKey: resolved.sessionKey,
                          entry: publication.entry,
                          fullEntry: publication.fullEntry,
                        });
                      }
                      if (publication.projectionNeedsReconcile) {
                        startSessionTranscriptIndexReconcile({
                          ...options,
                          preferredSessionId: resolved.sessionId,
                        });
                      }
                      if (publication.transcriptUpdate) {
                        publishCommittedTranscriptUpdate(publication.transcriptUpdate);
                      }
                    }),
                  assertCurrent,
                ),
              () => worker.close(),
            );
          },
          () => execution.release(),
        );
        if (!result.ok && fenced.expectedWriterRunId !== undefined) {
          throw new SessionTranscriptWriterClaimReboundError(result.error);
        }
        return result;
      } catch (error) {
        // Preserve the stored-JSON error contract across the broker serialization boundary.
        if (error instanceof Error && error.name === "SyntaxError") {
          throw new SyntaxError(error.message, { cause: error });
        }
        throw error;
      }
    };
    return admission
      ? operate()
      : runExclusiveSqliteSessionWrite(resolved, operate, "session.transcript.report");
  };
  return settleReportOperation(
    async () => {
      if (sourceAssertion) {
        if (!sourceAssertion.prepareSessionSource) {
          throw new Error("Composed report sources require worker-prepared authority");
        }
        composedSource = await prepareSessionSourceAuthority(sourceAssertion);
        if (composedSource.nativeSource || composedSource.hasOpaqueCheck) {
          throw new Error("Composed report sources require worker-prepared authority");
        }
      }
      return admission
        ? runExclusiveSqliteSessionWrite(admission, prepare, "session.transcript.report")
        : prepare();
    },
    async () => {
      await composedSource?.release?.();
    },
  );
}
