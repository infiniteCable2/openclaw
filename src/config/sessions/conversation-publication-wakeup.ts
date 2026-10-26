import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";

const log = createSubsystemLogger("sessions/conversation-publication");

/** Loading the background owner must not pull its stores into native append initialization. */
export function wakeConversationPublication(target: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const failed = () =>
    log.warn("Conversation publication wakeup unavailable; saved work remains pending.", {
      agentId: target.agentId,
      errorCode: "owner-unavailable",
    });
  try {
    const captured = { ...target, env: cloneEnvWithPlatformSemantics(target.env ?? process.env) };
    runInDetachedAsyncContext(() => {
      void import("./conversation-publication-reconcile.js")
        .then(({ startConversationKnowledgePublication }) =>
          startConversationKnowledgePublication(captured),
        )
        .catch(failed);
    });
  } catch {
    failed();
  }
}
