import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { createSandboxBridgeReadFile } from "../sandbox-media-paths.js";
import type { resolveEffectiveCurrentChannelContextForRequest } from "./message-tool-discovery.js";
import type { MessageToolOptions } from "./message-tool-execution.types.js";

export function resolveMessageToolExecutionContext(
  options: MessageToolOptions | undefined,
  effectiveCurrentChannel: Awaited<
    ReturnType<typeof resolveEffectiveCurrentChannelContextForRequest>
  >,
  currentThreadTs: string | undefined,
  replyToMode: MessageToolOptions["replyToMode"],
) {
  return effectiveCurrentChannel.currentChannelId ||
    effectiveCurrentChannel.currentChatType ||
    effectiveCurrentChannel.currentChannelProvider ||
    effectiveCurrentChannel.currentMessagingTarget ||
    currentThreadTs ||
    typeof options?.currentMessageId === "number" ||
    hasNonEmptyString(options?.currentMessageId) ||
    replyToMode ||
    options?.hasRepliedRef ||
    options?.sameChannelThreadRequired
    ? {
        currentChannelId: effectiveCurrentChannel.currentChannelId,
        currentChatType: effectiveCurrentChannel.currentChatType,
        currentMessagingTarget: effectiveCurrentChannel.currentMessagingTarget,
        currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
        currentThreadTs,
        currentMessageId: options?.currentMessageId,
        replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sameChannelThreadRequired: options?.sameChannelThreadRequired,
        // Direct tool invocations should not add cross-context decoration.
        // The agent is composing a message, not forwarding from another chat.
        skipCrossContextDecoration: true,
      }
    : undefined;
}

export function resolveMessageToolSandboxMediaAccess(options: MessageToolOptions | undefined) {
  const sandboxRoot = options?.sandboxRoot?.trim();
  return sandboxRoot &&
    options?.sandboxFsBridge &&
    options.sandboxWorkspaceMediaReadAllowed === true
    ? {
        localRoots: [
          sandboxRoot,
          ...(options?.sandboxContainerWorkdir ? [options.sandboxContainerWorkdir] : []),
          ...(options?.sandboxReadOnlyResourceMounts?.map((mount) => mount.containerPath) ?? []),
        ],
        readFile: createSandboxBridgeReadFile({
          sandbox: { root: sandboxRoot, bridge: options.sandboxFsBridge },
        }),
        workspaceDir: sandboxRoot,
      }
    : undefined;
}
