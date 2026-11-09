import type { SandboxContext } from "../../sandbox/types.js";
import { isToolExecutionAllowed } from "../../tool-policy-shared.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export function resolveAttemptNativeWebSearchPolicy(
  attempt: EmbeddedRunAttemptParams,
  sessionKey: string,
  sandbox: SandboxContext | null | undefined,
) {
  return {
    // Provider-hosted search bypasses local execute hooks, so its request must
    // honor the same execution cap without changing foreground function schemas.
    webSearchEnabled:
      attempt.disableTools !== true &&
      attempt.toolOverrides?.webSearch !== false &&
      (!attempt.toolExecutionAllow ||
        isToolExecutionAllowed(attempt.toolExecutionAllow, "web_search")),
    runtimeToolAllowlist: attempt.toolsAllow,
    sessionKey,
    sandboxToolPolicy: sandbox?.tools,
    messageProvider: attempt.messageProvider ?? attempt.messageChannel,
    agentAccountId: attempt.agentAccountId,
    groupId: attempt.groupId,
    groupChannel: attempt.groupChannel,
    groupSpace: attempt.groupSpace,
    spawnedBy: attempt.spawnedBy,
    senderId: attempt.senderId,
    senderName: attempt.senderName,
    senderUsername: attempt.senderUsername,
    senderE164: attempt.senderE164,
  };
}
