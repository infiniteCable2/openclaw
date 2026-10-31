import path from "node:path";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createBackgroundWorkOwner } from "../../process/background-work.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";

const log = createSubsystemLogger("conversation-knowledge");
const background = createBackgroundWorkOwner({ owner: "conversation-knowledge", maxConcurrent: 1 });
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

type PrefetchTarget = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
  root: { sessionKey: string; sessionId: string; lifecycleRevision: string };
};

/** Notifications schedule authorized reads; neither their publisher nor this owner writes history. */
export function createConversationKnowledgePrefetchOwner(params: {
  target: PrefetchTarget;
  assertCurrent(): void;
  /** Scheduling hints only; each selected source still needs current native authority. */
  watchesSource?(sessionKey: string): boolean;
  /** Recipient delivery waits on runtime settlement; shared source preparation does not. */
  watchRecipientRuntime?: boolean;
  /** The hint avoids repeating source reads for recipient-only availability changes. */
  prepare(signal: AbortSignal, prepareSources?: boolean): Promise<void | boolean>;
  /** Native background capacity owner; slow summarization must not occupy source read-ahead. */
  workOwner?: Pick<ReturnType<typeof createBackgroundWorkOwner>, "enqueue">;
  /** Join retained asynchronous cleanup before releasing native database custody. */
  settle?(): Promise<void>;
  clear(): void;
}) {
  const target = {
    ...params.target,
    storePath: path.resolve(params.target.storePath),
    env: cloneEnvWithPlatformSemantics(params.target.env ?? process.env),
  };
  const root = { ...target.root };
  const controller = new AbortController();
  let execution: OpenClawAgentDatabaseExecution | undefined;
  let unregister = () => {};
  let unsubscribe = () => {};
  let unsubscribeRecipient = () => {};
  let requested = false;
  let sourcesRequested = false;
  let preparationPauses = 0;
  let completion: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelayMs = RETRY_MIN_MS;
  const reportedFailures = new Set<string>();

  const check = () => {
    controller.signal.throwIfAborted();
    params.assertCurrent();
    execution?.assertCurrent();
  };
  const warn = (errorCode: "preparation-deferred" | "cleanup-pending", error?: unknown) => {
    if (!reportedFailures.has(errorCode)) {
      reportedFailures.add(errorCode);
      const failureClass =
        error instanceof Error &&
        [
          "SessionTranscriptReadFenceError",
          "SessionMutationFactsUnavailableError",
          "SessionMutationAuthorizationChangedError",
          "PersonalConversationReadRefusedError",
          "RangeError",
          "AbortError",
        ].includes(error.name)
          ? error.name
          : "unknown";
      log.warn("Related-history background preparation remains deferred.", {
        errorCode,
        recipientHash: redactIdentifier(target.sessionId),
        rootHash: redactIdentifier(root.sessionId),
        failureClass,
      });
    }
  };
  const cancelRetry = () => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };
  const revoke = () => {
    controller.abort();
    cancelRetry();
    requested = false;
    sourcesRequested = false;
    unsubscribe();
    unsubscribeRecipient();
    try {
      params.clear();
    } catch {
      // Keep native resource custody so close can retry a failed cache/grant release.
      warn("cleanup-pending");
    }
  };
  const wait = async () => {
    for (let pending = completion; pending; pending = completion) {
      await pending;
    }
  };
  const close = (): Promise<void> => {
    if (closing) {
      return closing;
    }
    revoke();
    const attempt = (async () => {
      await wait();
      const failures: unknown[] = [];
      try {
        await params.settle?.();
      } catch (error) {
        failures.push(error);
      }
      try {
        params.clear();
      } catch (error) {
        failures.push(error);
      }
      // Failed child cleanup still needs this native owner; retry it before releasing custody.
      if (failures.length) {
        throw new AggregateError(failures, "Conversation knowledge cleanup remains pending");
      }
      await execution?.release();
      execution = undefined;
      unregister();
    })();
    closing = attempt;
    void attempt.catch(() => {
      // A failed cleanup stays registered and can be retried by the database owner.
      if (closing === attempt) {
        closing = undefined;
      }
      warn("cleanup-pending");
    });
    return attempt;
  };
  const stop = () => {
    void close().catch(() => {});
  };
  const assertCurrent = () => {
    try {
      check();
    } catch (error) {
      stop();
      throw error;
    }
  };
  const retry = () => {
    if (retryTimer !== undefined || controller.signal.aborted) {
      return;
    }
    if (preparationPauses > 0) {
      requested = true;
      return;
    }
    // Silence after a transient read failure must not strand an open recipient.
    // This owns one future wakeup, not accepted work that wait()/close() must join.
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      requested = true;
      schedule();
    }, retryDelayMs);
    retryTimer.unref?.();
    retryDelayMs = Math.min(RETRY_MAX_MS, retryDelayMs * 2);
  };
  const schedule = () => {
    if (completion || preparationPauses > 0 || controller.signal.aborted) {
      return;
    }
    const pending = runInDetachedAsyncContext(() =>
      Promise.resolve().then(async () => {
        while (requested && !controller.signal.aborted) {
          if (preparationPauses !== 0) {
            break;
          }
          requested = false;
          let preparingSources = false;
          try {
            check();
            // Each batch releases shared capacity before a coalesced successor is queued.
            await (params.workOwner ?? background).enqueue(
              async (signal) => {
                // A foreground drain may start after this quantum was queued.
                if (preparationPauses > 0) {
                  requested = true;
                  return;
                }
                check();
                signal.throwIfAborted();
                preparingSources = sourcesRequested;
                sourcesRequested = false;
                const more = await params.prepare(signal, preparingSources);
                signal.throwIfAborted();
                check();
                reportedFailures.delete("preparation-deferred");
                retryDelayMs = RETRY_MIN_MS;
                requested ||= more === true;
              },
              { abortSignal: controller.signal },
            );
          } catch (error) {
            if (controller.signal.aborted) {
              return;
            }
            // A failed quantum cannot consume its source notification. Keep it
            // through the existing backoff and any recipient-only wakeup.
            sourcesRequested ||= preparingSources;
            try {
              check();
            } catch {
              stop();
              return;
            }
            warn("preparation-deferred", error);
            if (!requested) {
              retry();
            }
          }
        }
      }),
    );
    const settled = pending.finally(() => {
      if (completion === settled) {
        completion = undefined;
      }
      // Preserve a wakeup delivered between the final loop check and settlement.
      if (requested && !controller.signal.aborted) {
        schedule();
      }
    });
    completion = settled;
    void settled.catch(() => {
      warn("preparation-deferred");
      stop();
    });
  };
  const request = (kind: "source" | "recipient" = "source") => {
    if (controller.signal.aborted) {
      return;
    }
    // Committed-root publishers only mark work; even authority checks run off their stack.
    cancelRetry();
    requested = true;
    sourcesRequested ||= kind === "source";
    schedule();
  };
  const pausePreparation = () => {
    if (controller.signal.aborted) {
      return () => {};
    }
    preparationPauses++;
    cancelRetry();
    let held = true;
    return () => {
      if (!held) {
        return;
      }
      held = false;
      preparationPauses--;
      if (preparationPauses === 0) {
        // A drain may have committed before cancellation. Refresh its progress
        // once, together with every notification received while paused.
        request();
      }
    };
  };

  params.assertCurrent();
  try {
    unregister = registerOpenClawAgentDatabaseAsyncResource({
      agentId: target.agentId,
      path: target.storePath,
      revoke,
      close,
    });
    execution = runInDetachedAsyncContext(() =>
      captureOpenClawAgentDatabaseExecution({
        agentId: target.agentId,
        path: target.storePath,
        env: target.env,
      }),
    );
    unsubscribe = onInternalSessionTranscriptUpdate((update) => {
      const changed = update.target;
      if (
        changed?.agentId === target.agentId &&
        changed.sessionId === root.sessionId &&
        changed.sessionKey === root.sessionKey &&
        changed.storePath &&
        path.resolve(changed.storePath) === target.storePath
      ) {
        request();
      }
    });
    unsubscribeRecipient = sessionChanges.subscribe((change) => {
      if (
        params.watchRecipientRuntime === true &&
        "sessionKey" in change &&
        change.scope === "runtime" &&
        change.sessionKey === target.sessionKey &&
        (change.agentId === undefined || change.agentId === target.agentId) &&
        (change.storePath === undefined || path.resolve(change.storePath) === target.storePath)
      ) {
        // Runtime settlement omits the store path. This is only an exact-key
        // wakeup; native recipient reads and commit guards still decide authority.
        request("recipient");
        return;
      }
      if (
        "sessionKey" in change &&
        change.scope === "session-entry" &&
        change.agentId === target.agentId &&
        (change.sessionKey === target.sessionKey || params.watchesSource?.(change.sessionKey)) &&
        change.storePath &&
        path.resolve(change.storePath) === target.storePath
      ) {
        request(change.sessionKey === target.sessionKey ? "recipient" : "source");
      }
    });
  } catch (error) {
    if (execution) {
      stop();
    } else {
      unregister();
    }
    throw error;
  }
  request();
  return { request, pausePreparation, close, assertCurrent, wait };
}
