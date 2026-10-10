import type { AgentLoopConfig, AgentMessage } from "./types.js";

/**
 * Own the final native queue checkpoint and publish normal completion without
 * yielding between the input owner's synchronous idle decision and agent_end.
 */
export async function resolveAgentLoopCompletion(params: {
  config: Pick<AgentLoopConfig, "getFollowUpMessages" | "waitForPendingInput">;
  getSteeringMessages: () => AgentMessage[] | Promise<AgentMessage[]>;
  signal?: AbortSignal;
  onAborted: () => Promise<boolean>;
  onComplete: () => void | Promise<void>;
}): Promise<AgentMessage[] | undefined> {
  while (true) {
    let pendingMessages = (await params.config.getFollowUpMessages?.()) || [];
    if (pendingMessages.length === 0) {
      // The follow-up getter may yield while steering is accepted. Preserve
      // the Agent-owned synchronous drain at this final checkpoint.
      const steering = params.getSteeringMessages();
      pendingMessages = Array.isArray(steering) ? steering : await steering;
    }
    if (params.signal?.aborted) {
      await params.onAborted();
      return undefined;
    }
    if (pendingMessages.length > 0) {
      return pendingMessages;
    }
    const pendingInput = params.config.waitForPendingInput?.(params.signal);
    if (!pendingInput) {
      if (params.signal?.aborted) {
        await params.onAborted();
      } else {
        // Invoke before awaiting: the synchronous empty decision must remain
        // adjacent to terminal publication, including across this helper call.
        await params.onComplete();
      }
      return undefined;
    }
    // Attach rejection handling even if the callback synchronously aborted.
    await waitForPendingInputOrAbort(pendingInput, params.signal);
    if (await params.onAborted()) {
      return undefined;
    }
  }
}

/** Abort releases a completion barrier even if its input producer never settles. */
async function waitForPendingInputOrAbort(
  pending: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await pending;
    return;
  }
  let releaseAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    releaseAbort = resolve;
    signal.addEventListener("abort", releaseAbort, { once: true });
    if (signal.aborted) {
      resolve();
    }
  });
  try {
    await Promise.race([pending, aborted]);
  } catch (error) {
    // Cancellation is projected by the loop's normal terminal owner.
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    signal.removeEventListener("abort", releaseAbort);
  }
}
