import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { drainConversationPublications } from "./conversation-publication-drain.js";
import { publishConversationPublication } from "./conversation-publication-publish.js";
import { openConversationPublicationStore } from "./conversation-publication.js";

type PublicationTarget = {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
  reportPending?: boolean;
};
type RunningPublication = {
  controller: AbortController;
  completion: Promise<void>;
  wake?: () => void;
  requested: boolean;
  reportPending: boolean;
};

const log = createSubsystemLogger("sessions/conversation-publication");
const running = resolveGlobalSingleton(
  Symbol.for("openclaw.conversationKnowledgePublicationReconcile"),
  () => new Map<string, RunningPublication>(),
);

/** No source read or root write occurs on the response caller's stack. */
export function startConversationKnowledgePublication(input: PublicationTarget): void {
  const target = {
    ...input,
    path: path.resolve(input.path),
    env: cloneEnvWithPlatformSemantics(input.env ?? process.env),
  };
  const key = JSON.stringify([target.agentId, target.path]);
  const existing = running.get(key);
  if (existing) {
    existing.requested = true;
    existing.reportPending ||= target.reportPending === true;
    existing.wake?.();
    return;
  }
  try {
    // This owner is independent of a turn's cancellation/ALS, but is revoked and
    // joined by the native database lifecycle before replacement or shutdown.
    runInDetachedAsyncContext(() => startOwnedPublication(target, key));
  } catch {
    // The durable journal, not this best-effort wakeup, owns recovery.
    log.warn("Conversation publication wakeup refused; saved work remains pending.", {
      agentId: target.agentId,
      errorCode: "owner-admission-failed",
    });
  }
}

function startOwnedPublication(target: PublicationTarget, key: string): void {
  const controller = new AbortController();
  const state: RunningPublication = {
    controller,
    requested: false,
    reportPending: target.reportPending === true,
    completion: Promise.resolve(),
  };
  let execution: OpenClawAgentDatabaseExecution | undefined;
  const check = () => {
    controller.signal.throwIfAborted();
    execution?.assertCurrent();
  };
  const releaseOwner = async () => {
    // Retain the map entry and native close resource if cleanup fails. Wakeups
    // cannot admit a successor until this exact owner has actually released.
    await execution?.release();
    execution = undefined;
    unregister();
    if (running.get(key) === state) {
      running.delete(key);
    }
  };
  const unregister = registerOpenClawAgentDatabaseAsyncResource({
    agentId: target.agentId,
    path: target.path,
    revoke() {
      controller.abort();
      state.wake?.();
    },
    async close() {
      controller.abort();
      state.wake?.();
      await state.completion.catch(() => {});
      // A failed release must remain registered for native cleanup to retry.
      await releaseOwner();
    },
  });
  try {
    // Capture the selected physical generation before yielding to another owner.
    execution = captureOpenClawAgentDatabaseExecution(target);
  } catch (error) {
    unregister();
    throw error;
  }
  running.set(key, state);
  state.completion = (async () => {
    let drained = false;
    try {
      await yieldToEventLoop();
      check();
      const store = openConversationPublicationStore({ ...target, assertCurrent: check });
      let infrastructureFailures = 0;
      for (;;) {
        check();
        state.requested = false;
        try {
          if (state.reportPending) {
            const retained = (await store.stats()).filter(
              (row) => row.state !== "ready" && row.count > 0,
            );
            check();
            state.reportPending = false;
            if (retained.length > 0) {
              log.warn(
                "Conversation publication retains unconfirmed or blocked work; no task will be replayed.",
                {
                  agentId: target.agentId,
                  states: retained,
                },
              );
            }
          }
          await drainConversationPublications({
            store,
            assertCurrent: check,
            now: Date.now,
            publish: (row) =>
              publishConversationPublication({
                ...target,
                row,
                signal: controller.signal,
                assertCurrent: check,
              }),
            warn: (event) =>
              log.warn("Conversation publication remains pending; no task was repeated.", event),
          });
          check();
          const nextAt = await store.nextAttemptAt();
          check();
          infrastructureFailures = 0;
          if (state.requested) {
            await yieldToEventLoop();
          } else if (nextAt === undefined) {
            drained = true;
            break;
          } else if (nextAt <= Date.now()) {
            // Small batches yield between branches instead of monopolizing their writer.
            await yieldToEventLoop();
          } else {
            await waitForPublicationWake(state, Math.min(nextAt - Date.now(), 300_000));
          }
        } catch {
          check();
          infrastructureFailures++;
          log.warn("Conversation publication storage unavailable; saved work remains pending.", {
            agentId: target.agentId,
            errorCode: "journal-unavailable",
            attempt: infrastructureFailures,
          });
          await waitForPublicationWake(
            state,
            Math.min(300_000, 1_000 * 2 ** Math.min(infrastructureFailures - 1, 9)),
          );
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        log.warn("Conversation publication owner stopped; saved work remains pending.", {
          agentId: target.agentId,
          errorCode: "owner-unavailable",
        });
      }
    } finally {
      state.wake?.();
      await releaseOwner();
      // A commit can wake this owner while release is still joining native
      // work. Hand it off only after release, and never resurrect revoked work.
      if (drained && state.requested && !controller.signal.aborted) {
        startConversationKnowledgePublication({ ...target, reportPending: state.reportPending });
      }
    }
  })();
  // Observe lifecycle cleanup failure without losing the registered close owner.
  void state.completion.catch(() =>
    log.warn("Conversation publication cleanup remains owned by database lifecycle.", {
      agentId: target.agentId,
      errorCode: "owner-cleanup-pending",
    }),
  );
}

function waitForPublicationWake(state: RunningPublication, milliseconds: number): Promise<void> {
  if (state.requested || state.controller.signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (state.wake === done) {
        state.wake = undefined;
      }
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    state.wake = done;
  });
}

/** Joins scheduled work and release-time handoffs; response paths never call this hook. */
export async function waitForConversationKnowledgePublication(target: PublicationTarget) {
  const key = JSON.stringify([target.agentId, path.resolve(target.path)]);
  for (let state = running.get(key); state; state = running.get(key)) {
    await state.completion;
  }
}
