import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { isDeliverableMessageChannel } from "../utils/message-channel-normalize.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import type { CronToolOptions } from "./tools/cron-tool.types.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createOpenClawDelegateToolsForRun } from "./tools/openclaw-delegate-tool.js";
import { createPersonalInstructionsTool } from "./tools/personal-instructions-tool.js";
import { createPluginsTool } from "./tools/plugins-tool.js";
import { createPresenceTool } from "./tools/presence-tool.js";

/** Capture the scheduled-tool authority and durable source for hosted cron calls. */
export function createHostedCronTool(
  options: OpenClawToolsOptions | undefined,
  sessionAgentId: string,
  gatewayCallerAccountId: string | undefined,
  deliveryContext: CronToolOptions["currentDeliveryContext"],
): AnyAgentTool {
  return createCronTool({
    ...options,
    // Use the durable runSessionKey; cleanup-retired policy keys leave cron jobs dangling.
    agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
    agentId: sessionAgentId,
    agentAccountId: gatewayCallerAccountId,
    currentDeliveryContext: deliveryContext,
    requireExplicitDeliveryTarget:
      Boolean(options?.agentChannel) &&
      options?.agentChannel !== INTERNAL_MESSAGE_CHANNEL &&
      !isDeliverableMessageChannel(options?.agentChannel ?? ""),
    sandboxContext: options?.cronSandboxContext,
    creatorToolAllowlist: options?.cronCreatorToolAllowlist,
    creatorToolAllowlistCaptureRef: options?.cronCreatorToolAllowlistCaptureRef,
    resolveCreatorToolAuthority: options?.resolveCronCreatorToolAuthority,
    creatorAuthorityUnavailableReason: options?.cronCreatorAuthorityUnavailableReason,
    selfRemoveOnlyJobId: options?.cronSelfRemoveOnlyJobId,
  });
}

/** Gateway-owned operations are not standalone embedded-host capabilities. */
export function createHostedGatewayTools(
  embedded: boolean,
  sessionAgentId: string,
  options?: OpenClawToolsOptions,
  preparedDelegateTools?: AnyAgentTool[],
  personalInstructionsEnabled = false,
): AnyAgentTool[] {
  if (embedded) {
    return [];
  }
  return [
    createPresenceTool({ runId: options?.runId }),
    createGatewayTool({
      allowConfigReads: options?.gatewayConfigReadAllowed === true,
      senderIsOwner: options?.senderIsOwner,
      operatorAuthority: options?.pluginExecutionAuthority,
      requesterSenderId: options?.requesterSenderId,
    }),
    createPluginsTool({
      sessionId: options?.sessionId,
      runId: options?.runId,
      onYield: options?.onYield,
      senderIsOwner: options?.senderIsOwner,
    }),
    ...(preparedDelegateTools ?? createOpenClawDelegateToolsForRun({ ...options, sessionAgentId })),
    ...(personalInstructionsEnabled ? [createPersonalInstructionsTool(sessionAgentId)] : []),
  ];
}
