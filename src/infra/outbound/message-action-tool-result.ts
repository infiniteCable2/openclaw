import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { MessageActionResult } from "./message-action-contracts.js";

export function getToolResult(result: MessageActionResult): AgentToolResult<unknown> | undefined {
  const toolResult = "toolResult" in result ? result.toolResult : undefined;
  if (result.kind !== "send" || !result.accountId) {
    return toolResult;
  }
  const response = toolResult ?? jsonResult(result.payload);
  // Successful-send extraction must see the routed account, including bindings.
  return {
    ...response,
    details: { ...asOptionalRecord(response.details), accountId: result.accountId },
  };
}
