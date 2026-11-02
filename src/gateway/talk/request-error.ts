import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope.js";
import { resolveUserMessageLocale } from "../../shared/language.js";
import { resolveUserMessages } from "../../shared/user-messages.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { formatForLog } from "../ws-log.js";

/** Client errors omit Talk issues; legacy relay errors always report unavailable. */
export function talkRequestError(
  error: unknown,
  projection: "client" | "session" | "legacy-relay" = "client",
  language?: string,
) {
  const classify = projection !== "legacy-relay";
  if (classify && error instanceof SessionMutationAuthorizationChangedError) {
    return error.error;
  }
  const invalidRequest = classify && error instanceof AgentSelectionRequiredError;
  const message =
    !invalidRequest && resolveUserMessageLocale(language) !== "en"
      ? resolveUserMessages(language).voiceConnectionFailed
      : formatForLog(error);
  return errorShape(
    invalidRequest ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
    message,
    !invalidRequest && projection !== "client"
      ? { details: { talkIssue: { code: "realtime_unavailable", message, phase: "request" } } }
      : undefined,
  );
}
