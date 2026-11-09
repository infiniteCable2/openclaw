import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureAgentRunLifecycleGeneration } from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { bindAgentRunTerminalWriteSettlement } from "../../infra/agent-run-terminal-writes.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { logSessionTurnCreated } from "../../logging/diagnostic.js";
import {
  isCronExecutionInputProvenance,
  progressCardRefreshRunProjection,
} from "../../sessions/input-provenance.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { resolveReplySessionEventDelivery } from "./reply-operation-run-state.js";
import { resolveReplyRunTrigger } from "./reply-turn-kind.js";

/** Registers lifecycle visibility and diagnostics for the admitted turn. */
export function registerAgentTurnExecutionContext(
  params: AgentTurnParams,
  runId: string,
  runtimeConfig: OpenClawConfig,
  preparedRunAdmission: PreparedAgentRunAdmission,
) {
  const messageProvider =
    params.followupRun.run.messageProvider ??
    params.sessionCtx.Surface ??
    params.sessionCtx.Provider;
  const shouldSurfaceToControlUi = isInternalMessageChannel(messageProvider);
  const lifecycleGeneration = captureAgentRunLifecycleGeneration(runId);
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      ...(params.followupRun.run.sessionId ? { sessionId: params.followupRun.run.sessionId } : {}),
      agentId: params.followupRun.run.agentId,
      lifecycleGeneration,
      verboseLevel: params.resolvedVerboseLevel,
      isControlUiVisible: shouldSurfaceToControlUi,
      ...progressCardRefreshRunProjection(params.followupRun.run.inputProvenance),
      // Scheduled checks must not replace foreground status; their authored results still publish.
      ...(isCronExecutionInputProvenance(params.followupRun.run.inputProvenance)
        ? { projectSessionActive: false, projectSessionLifecycle: false }
        : {}),
      completionSource: params.completionSource,
      sessionEventDelivery: resolveReplySessionEventDelivery(params.opts, params.followupRun.run),
    });
    bindAgentRunTerminalWriteSettlement(preparedRunAdmission.operationalRunInstance);
  }
  if (isDiagnosticsEnabled(runtimeConfig)) {
    const trigger = resolveReplyRunTrigger(params);
    logSessionTurnCreated({
      runId,
      sessionKey: params.sessionKey,
      sessionId: params.followupRun.run.sessionId,
      agentId: params.followupRun.run.agentId,
      channel: messageProvider,
      trigger: trigger === "cron" ? "event" : trigger,
    });
  }
  return { lifecycleGeneration, shouldSurfaceToControlUi };
}
