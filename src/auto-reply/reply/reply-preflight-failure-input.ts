import { logVerbose } from "../../globals.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { buildPreflightCompactionFailureText } from "./agent-runner-failure-reply.js";
import type { FollowupRun } from "./queue/types.js";

export async function persistReplyInputAfterPreflightFailure(
  error: unknown,
  followupRun: FollowupRun,
  operation: ReplyOperation,
): Promise<void> {
  const recorder = followupRun.userTurnTranscriptRecorder;
  if (recorder && buildPreflightCompactionFailureText(formatErrorMessage(error)) !== null) {
    try {
      // Keep approved input after failed maintenance without claiming a recovery turn.
      await recorder.persistApproved({
        expectedSessionId: operation.sessionId,
        beforeFreshMessageCommit: () => {
          operation.abortSignal.throwIfAborted();
          followupRun.operatorAuthority?.assertCurrent();
          if (operation.lifecycleGeneration) {
            assertAgentRunLifecycleGenerationCurrent(operation.lifecycleGeneration);
          }
        },
      });
    } catch (persistError) {
      logVerbose(`user turn not kept after failed preflight: ${formatErrorMessage(persistError)}`);
    }
  }
}
