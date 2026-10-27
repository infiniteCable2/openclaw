import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type {
  SessionTranscriptModelContextRange,
  SessionTranscriptModelContextRangeResult,
} from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import { captureIncognitoSessionHistoryBinding } from "./session-incognito-binding.js";
import {
  prepareIncognitoSessionHistoryRead,
  type IncognitoSessionHistoryBinding,
} from "./session-incognito-history-read.js";
import { assertSessionModelContextBatchBudget } from "./session-model-context-batch-limits.js";
import {
  readSessionTranscriptAnchorsAsync,
  readSessionTranscriptAnchorsFromSource,
} from "./session-transcript-anchor-read.js";
import { retainSessionTranscriptContextGeneration } from "./session-transcript-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import {
  resolveSessionTranscriptReadFence,
  withSessionContextAdmission,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import {
  readSessionTranscriptModelContextInWorker,
  readSessionTranscriptModelContextsInWorker,
} from "./session-transcript-read-worker-runtime.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { getOwnedSessionTranscriptReader } from "./transcript-write-context.js";

export type SessionTranscriptContextProjectionSource = {
  target: SessionTranscriptRuntimeTarget;
  admission?: UserTurnTranscriptAdmissionReceipt;
  /** Presence pins a durable source; undefined identity means the captured file was absent. */
  physicalSource?: { expectedIdentity: DatabaseFileIdentity | undefined };
};

/** Retain exact source generations until every bounded historical range is accepted. */
export async function readSessionTranscriptModelContextsAsync<T>(
  target: SessionTranscriptRuntimeTarget,
  ranges: readonly SessionTranscriptModelContextRange[],
  consume: (contexts: SessionTranscriptModelContextRangeResult[]) => T,
  signal?: AbortSignal,
): Promise<T> {
  assertSessionModelContextBatchBudget(ranges);
  const captured = { ...target };
  const requests = structuredClone([...ranges]);
  const currentAdmission = resolveSessionTranscriptReadFence(captured);
  const admission = currentAdmission && structuredClone(currentAdmission);
  const accept = async (
    scope: SessionTranscriptRuntimeTarget,
    contexts: SessionTranscriptModelContextRangeResult[],
    assertCurrent: () => void,
    databaseIdentity?: string,
  ): Promise<T> => {
    if (contexts.length !== requests.length) {
      throw new Error("Session context batch omitted a requested range");
    }
    const generations: Array<
      ReturnType<typeof retainSessionTranscriptContextGeneration> | undefined
    > = [];
    const validate = async () => {
      for (const [index, result] of contexts.entries()) {
        if (!result.ok) {
          continue;
        }
        await readSessionTranscriptAnchorsAsync(
          scope,
          {
            entryIds: [],
            contextValidation: {
              version: result.context.version,
              admission,
              through: requests[index]!.through,
              from: requests[index]!.limits.from,
            },
          },
          signal,
          (facts) => {
            assertCurrent();
            generations[index]!.assertCurrent();
            if (!facts.contextValidated) {
              throw new SessionTranscriptReadFenceError(
                "Session transcript changed during context batch read",
              );
            }
          },
        );
      }
      for (const generation of generations) {
        generation?.assertCurrent();
      }
      assertCurrent();
      signal?.throwIfAborted();
    };
    try {
      for (const result of contexts) {
        generations.push(
          result.ok
            ? retainSessionTranscriptContextGeneration(
                scope,
                result.context.version,
                databaseIdentity,
              )
            : undefined,
        );
      }
      await validate();
      const consumed = consume(contexts);
      if (isPromiseLike(consumed)) {
        const value = await consumed;
        await validate();
        return value;
      }
      return consumed;
    } finally {
      for (const generation of generations) {
        generation?.release();
      }
    }
  };
  return withSessionTranscriptReadSource(
    captured,
    async (scope) => {
      // Process-held histories keep their native single-read authority owner.
      const contexts: SessionTranscriptModelContextRangeResult[] = [];
      for (const range of requests) {
        try {
          contexts.push({
            ok: true,
            context: await readSessionTranscriptModelContextAsync(
              captured,
              (value) => value,
              admission,
              signal,
              range.through,
              range.limits,
            ),
          });
        } catch (error) {
          if (
            !(error instanceof SessionTranscriptReadFenceError) &&
            !(error instanceof RangeError)
          ) {
            throw error;
          }
          contexts.push({
            ok: false,
            reason:
              error instanceof RangeError
                ? "source-range-over-capacity"
                : "source-range-unverified",
          });
        }
      }
      return accept(scope, contexts, () => signal?.throwIfAborted());
    },
    async ({ scope, expectedIdentity, assertCurrent }) => {
      const selected = { ...scope, sessionKey: captured.sessionKey };
      const contexts = await readSessionTranscriptModelContextsInWorker(
        { target: selected, ranges: requests, admission, expectedIdentity },
        signal,
      );
      assertCurrent();
      return accept(
        selected,
        contexts,
        assertCurrent,
        expectedIdentity?.key.startsWith("file:") ? expectedIdentity.key.slice(5) : undefined,
      );
    },
    signal,
  );
}

/** Keep a worker's bounded projection attached to its physical source until final acceptance. */
export async function readSessionTranscriptContextProjectionAsync<T>(
  target: SessionTranscriptRuntimeTarget,
  project: (
    source: SessionTranscriptContextProjectionSource,
  ) => Promise<{ value: T; version?: SessionTranscriptContextVersion }>,
  signal?: AbortSignal,
): Promise<T> {
  const captured = { ...target };
  const admission = resolveSessionTranscriptReadFence(captured);
  const capturedAdmission = admission && structuredClone(admission);
  return withSessionTranscriptReadSource(
    captured,
    async (scope) => {
      const result = await project({
        target: { ...captured, ...scope },
        admission: capturedAdmission,
      });
      let accepted = false;
      await readSessionTranscriptAnchorsAsync(
        { ...scope, sessionKey: captured.sessionKey },
        {
          entryIds: [],
          contextValidation: { version: result.version, admission: capturedAdmission },
        },
        signal,
        (facts) => {
          accepted = facts.contextValidated === true || (!result.version && !capturedAdmission);
        },
      );
      if (!accepted) {
        throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
      }
      return result.value;
    },
    async (source) => {
      const scope = { ...source.scope, sessionKey: captured.sessionKey };
      const result = await project({
        target: { ...captured, ...scope },
        admission: capturedAdmission,
        physicalSource: { expectedIdentity: source.expectedIdentity },
      });
      source.assertCurrent();
      let accepted = false;
      await readSessionTranscriptAnchorsFromSource(
        { ...source, scope },
        {
          entryIds: [],
          contextValidation: { version: result.version, admission: capturedAdmission },
        },
        signal,
        (facts) => {
          source.assertCurrent();
          accepted = facts.contextValidated === true || (!result.version && !capturedAdmission);
        },
      );
      if (!accepted) {
        throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
      }
      return result.value;
    },
    signal,
    targetDiscoveryLane,
  );
}

/** Accept consumed results while the original writer FIFO and native witness remain current. */
export function readSessionTranscriptModelContextAsync<T>(
  target: SessionTranscriptRuntimeTarget,
  consume: (context: SessionTranscriptModelContext) => T,
  admission?: UserTurnTranscriptAdmissionReceipt,
  signal?: AbortSignal,
  through?: TranscriptEntryAnchor,
  limits?: SessionModelContextLimits,
  suppliedIncognito?: IncognitoSessionHistoryBinding,
  consumeSynchronously = false,
): Promise<T> {
  const capturedTarget = { ...target };
  const capturedAdmission = admission ? structuredClone(admission) : undefined;
  const capturedThrough = through ? structuredClone(through) : undefined;
  const capturedLimits = limits ? structuredClone(limits) : undefined;
  const accept = async (
    scope: SessionTranscriptRuntimeTarget,
    context: SessionTranscriptModelContext,
    assertCurrent: () => void,
    binding?: IncognitoSessionHistoryBinding,
    contextAdmission = capturedAdmission,
    databaseIdentity?: string,
  ): Promise<T> => {
    const generation = retainSessionTranscriptContextGeneration(
      scope,
      context.version,
      databaseIdentity,
    );
    const contextValidation = structuredClone({
      version: context.version,
      admission: contextAdmission,
      through: capturedThrough,
      from: capturedLimits?.from,
    });
    const validate = async <Value>(publish: () => Value): Promise<{ value: Value }> => {
      let accepted: { value: Value } | undefined;
      await readSessionTranscriptAnchorsAsync(
        scope,
        { entryIds: [], contextValidation },
        signal,
        (facts) => {
          assertCurrent();
          generation.assertCurrent();
          if (
            !facts.contextValidated &&
            (contextValidation.version || contextAdmission || capturedThrough)
          ) {
            throw new SessionTranscriptReadFenceError(
              "Session transcript changed during context read",
            );
          }
          accepted = { value: publish() };
        },
        binding,
      );
      if (!accepted) {
        throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
      }
      return accepted;
    };
    let consumerSettlement: Promise<Awaited<T>> | undefined;
    let joined = false;
    try {
      const accepted = await validate(() => {
        const value = consume(context);
        if (isPromiseLike(value)) {
          consumerSettlement = Promise.resolve(value);
          void consumerSettlement.catch(() => undefined);
        }
        return value;
      });
      if (!consumerSettlement) {
        return accepted.value;
      }
      const value = await consumerSettlement;
      joined = true;
      return (await validate(() => value)).value;
    } finally {
      generation.release();
      // Initial acceptance can fail after starting a consumer; its owner still joins that work.
      if (consumerSettlement && !joined) {
        await consumerSettlement.catch(() => undefined);
      }
    }
  };
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryBinding(target);
  if (incognito) {
    const prepared = prepareIncognitoSessionHistoryRead(incognito, target, signal);
    const contextAdmission = capturedAdmission ?? prepared.target.admission;
    return prepared.actor.sessions
      .withSharedState(async () => {
        const context = await prepared.actor.sessions.history(
          prepared.authority,
          {
            type: "session.history.context",
            input: {
              ...prepared.target,
              admission: contextAdmission,
              through: capturedThrough,
              limits: capturedLimits,
            },
          },
          signal,
        );
        return accept(
          capturedTarget,
          context,
          prepared.authority.assertCurrent,
          prepared,
          contextAdmission,
        );
      })
      .then((result) => {
        prepared.authority.assertCurrent();
        return result;
      });
  }
  return withSessionTranscriptReadSource(
    capturedTarget,
    async (scope) => {
      // Capture incognito synchronously, then revalidate after the public async boundary.
      const context = await Promise.resolve(
        withSessionContextAdmission(capturedTarget, capturedAdmission, () =>
          readSessionTranscriptModelContext(scope, capturedThrough, capturedLimits),
        ),
      );
      return accept(capturedTarget, context, () => signal?.throwIfAborted());
    },
    async ({ scope, expectedIdentity, assertCurrent }) => {
      const captured = { ...scope, sessionKey: capturedTarget.sessionKey };
      const selected =
        consumeSynchronously && capturedLimits && getOwnedSessionTranscriptReader(captured);
      if (selected) {
        const { captureSessionEntryNativeMutationWitness } =
          await import("./session-entry-read-ordered.js");
        assertCurrent();
        const database = selected.database;
        return runOpenClawAgentWriteAdmission(
          database,
          async (_identity, assertOwner) => {
            assertCurrent();
            const assertNative = captureSessionEntryNativeMutationWitness([database]);
            const context = await readSessionTranscriptModelContextInWorker(
              captured,
              capturedAdmission,
              signal,
              capturedThrough,
              capturedLimits,
              expectedIdentity,
            );
            signal?.throwIfAborted();
            assertOwner();
            assertCurrent();
            assertNative();
            const value = consume(context);
            if (isPromiseLike(value)) {
              void Promise.resolve(value).catch(() => {});
              throw new Error("Prepared model-context consumers must remain synchronous");
            }
            assertOwner();
            assertCurrent();
            assertNative();
            return value;
          },
          true,
          undefined,
          signal,
        );
      }
      const context = await readSessionTranscriptModelContextInWorker(
        captured,
        capturedAdmission,
        signal,
        capturedThrough,
        capturedLimits,
        expectedIdentity,
      );
      assertCurrent();
      return accept(
        captured,
        context,
        assertCurrent,
        undefined,
        capturedAdmission,
        expectedIdentity?.key.startsWith("file:") ? expectedIdentity.key.slice(5) : undefined,
      );
    },
    signal,
  );
}
