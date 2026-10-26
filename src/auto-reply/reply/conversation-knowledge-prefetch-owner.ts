import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createBackgroundWorkOwner } from "../../process/background-work.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";

const log = createSubsystemLogger("conversation-knowledge");
const background = createBackgroundWorkOwner({ owner: "conversation-knowledge", maxConcurrent: 1 });

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
  prepare(signal: AbortSignal): Promise<void>;
  clear(): void;
  /** Schedule recipient maintenance outside the bounded source-read leaf pool. */
  onRequest?(signal: AbortSignal): void;
  /** Database retirement must join accepted recipient writes as well as source reads. */
  settle?(): Promise<void>;
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
  let requested = false;
  let completion: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const reportedFailures = new Set<string>();

  const check = () => {
    controller.signal.throwIfAborted();
    params.assertCurrent();
    execution?.assertCurrent();
  };
  const warn = (errorCode: "preparation-deferred" | "cleanup-pending") => {
    if (!reportedFailures.has(errorCode)) {
      reportedFailures.add(errorCode);
      log.warn("Related-history background preparation remains deferred.", { errorCode });
    }
  };
  const revoke = () => {
    controller.abort();
    requested = false;
    unsubscribe();
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
      await params.settle?.();
      params.clear();
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
  const schedule = () => {
    if (completion || controller.signal.aborted) {
      return;
    }
    const pending = runInDetachedAsyncContext(() =>
      Promise.resolve().then(async () => {
        while (requested && !controller.signal.aborted) {
          requested = false;
          try {
            check();
            // Never check authority or start recipient work on the root publisher's stack.
            params.onRequest?.(controller.signal);
            // Each batch releases shared capacity before a coalesced successor is queued.
            await background.enqueue(
              async (signal) => {
                check();
                signal.throwIfAborted();
                await params.prepare(signal);
                signal.throwIfAborted();
                check();
                reportedFailures.delete("preparation-deferred");
              },
              { abortSignal: controller.signal },
            );
          } catch {
            if (controller.signal.aborted) {
              return;
            }
            try {
              check();
            } catch {
              stop();
              return;
            }
            // A new notification may retry; no timer or model request is manufactured.
            warn("preparation-deferred");
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
  const request = () => {
    if (controller.signal.aborted) {
      return;
    }
    // Committed-root publishers only mark work; even authority checks run off their stack.
    requested = true;
    schedule();
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
  } catch (error) {
    if (execution) {
      stop();
    } else {
      unregister();
    }
    throw error;
  }
  request();
  return { request, close, assertCurrent, wait };
}
