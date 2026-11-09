import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
import { buildHandledBeforeAgentReplyPayloads } from "../../../plugins/before-agent-reply.js";
import { sanitizeAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import type { EmbeddedAgentRunResult } from "../types.js";

/** A claimed hook reply completes the run without starting its model provider. */
export function buildBeforeAgentReplyResult(
  reply: ReplyPayload | undefined,
  started: number,
  context: { sessionId: string; modelProviderId: string; modelId: string },
): EmbeddedAgentRunResult {
  return {
    payloads: buildHandledBeforeAgentReplyPayloads(reply),
    meta: {
      durationMs: Date.now() - started,
      agentMeta: {
        sessionId: context.sessionId,
        provider: context.modelProviderId,
        model: context.modelId,
      },
      terminalReply: reply
        ? sanitizeAgentRunTerminalReply(reply.text ?? "")
        : { disposition: "silent" },
      providerStarted: false,
    },
  };
}
