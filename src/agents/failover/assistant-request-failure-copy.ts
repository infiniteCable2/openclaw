import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  CONTEXT_OVERFLOW_ERROR_MESSAGE,
  extractErrorHttpStatus,
  formatTransportErrorCopy,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import { escapeMarkdownText } from "../../shared/text/escape-markdown.js";
import { resolveUserMessages } from "../../shared/user-messages.js";
import { classifyFailoverSignalCore } from "./classify-core.js";
import { isContextOverflowErrorFromTables } from "./context-overflow-tables.js";
import {
  isServerErrorMessage,
  isSessionTranscriptValidationErrorMessage,
  isUnsupportedReasoningEffortParameterError,
  resolveExecutionApprovalFailureMessage,
} from "./message-patterns.js";
import { extractFailoverSignalDetails } from "./signal-details.js";
import type { FailoverReason } from "./signal.js";

export const ERROR_PREFIX_RE =
  /^(?:error|(?:[a-z][\w-]*\s+)?api\s*error|openai\s*error|anthropic\s*error|gateway\s*error|codex\s*error|request failed|failed|exception)(?:\s+\d{3})?[:\s-]+/i;
export const PROVIDER_SCHEMA_REJECTION_USER_TEXT = resolveUserMessages().requestFailure.format;
const PROVIDER_OUTPUT_TOKEN_LIMIT_RE =
  /^['"]?max_(?:tokens|output_tokens|completion_tokens|new_tokens)['"]?\s*(?:[:=]\s*)?\(?(\d[\d,]*)\)?\s+exceeds?\b.{0,120}?\b(?:maximum|max|limit)\b(?:\s+(?:output\s+)?tokens?)?(?:\s+(?:is|of)|\s*[:=])?\s*\(?(\d[\d,]*)\)?(?:\D|$)/i;
const PROVIDER_CACHE_CONTROL_LIMIT_RE =
  /^A maximum of (\d{1,6}) blocks with cache_control may be provided\. Found (\d{1,6})\.$/i;

type AssistantRequestFailureCopyFacts = {
  language?: string;
  provider?: string;
  model?: string;
  reason?: FailoverReason | null;
  status?: number;
  storageFailure?: GatewayStorageFailure;
  code?: string;
};

export const ERROR_DETAILS_HINT = resolveUserMessages().replyDetailsHint;

const STORAGE_FAILURE_COPY = resolveUserMessages().storageFailure;
const ASSISTANT_REQUEST_FAILURE_COPY = resolveUserMessages().requestFailure;

/** Plain storage copy for length-limited surfaces such as session rows. */
export function renderStorageFailureSummary(
  storageFailure: GatewayStorageFailure | undefined,
): string | undefined {
  return storageFailure ? STORAGE_FAILURE_COPY[storageFailure] : undefined;
}

/** Render classified facts without exposing raw provider response text. */
export function renderAssistantRequestFailureCopy(
  facts: AssistantRequestFailureCopyFacts,
): string | undefined {
  const messages = resolveUserMessages(facts.language);
  if (facts.storageFailure) {
    return `⚠️ ${messages.storageFailure[facts.storageFailure]} ${messages.replyDetailsHint}`;
  }
  if (facts.code === "incomplete_tool_call") {
    return messages.replyTaskIncomplete;
  }
  const reason =
    facts.reason === "timeout" && typeof facts.status === "number" && facts.status >= 500
      ? "server_error"
      : facts.reason;
  const copy = reason ? messages.requestFailure[reason] : undefined;
  if (copy) {
    return `⚠️ ${copy}`;
  }
  const hasStatus =
    facts.status !== undefined &&
    Number.isInteger(facts.status) &&
    facts.status >= 100 &&
    facts.status <= 599;
  if (!hasStatus && !facts.provider?.trim() && !facts.model?.trim()) {
    return undefined;
  }
  return `⚠️ ${messages.replyFinishFailed} ${messages.replyDetailsHint}`;
}

/** Render already-classified coordination facts without loading provider runtime. */
export function renderRuntimeCoordinationFailureCopy(
  code: string | undefined,
  language?: string,
): string | undefined {
  const copy = code ? resolveUserMessages(language).runtimeCoordinationFailure[code] : undefined;
  return copy ? `⚠️ ${copy}` : undefined;
}

type FailureCopyOptions = {
  /** Include a diagnostic excerpt when no specialized format guidance matches. */
  includeRawFormatDetails?: boolean;
};

/** Preserve the rejection diagnostic without publishing the surrounding response body. */
export function renderFormatErrorCopy(raw: string, options?: FailureCopyOptions): string {
  const trimmed = raw.trim();
  const normalized =
    extractErrorHttpStatus(trimmed)?.rest ?? trimmed.replace(ERROR_PREFIX_RE, "").trim();
  let candidate = extractErrorHttpStatus(normalized)?.rest ?? normalized;
  // Some proxies serialize the upstream error inside their own error.message.
  for (let depth = 0; depth < 4; depth++) {
    // HTTP reason phrases can precede a body, including inside a proxy's message.
    candidate = (extractErrorHttpStatus(candidate)?.rest ?? candidate).replace(
      /^(?:bad request|unprocessable (?:entity|content))\s*:?\s*(?=[{[<])/iu,
      "",
    );
    const parsedMessage = parseApiErrorInfo(candidate)?.message?.trim();
    if (!parsedMessage || parsedMessage === candidate) {
      break;
    }
    candidate = parsedMessage;
  }
  if (isSessionTranscriptValidationErrorMessage(candidate)) {
    return "OpenClaw couldn't read this conversation's history. Ask the Gateway operator to try `openclaw doctor --fix`. If it still fails, preserve the history and contact support with the Gateway logs.";
  }
  const embeddingModel = candidate.match(/^"([\w./:-]{1,200})" does not support chat$/u)?.[1];
  if (embeddingModel) {
    const model = escapeMarkdownText(redactSensitiveText(embeddingModel, { mode: "tools" }));
    return `${model} is an embedding model and cannot chat; pick a chat model with /model (or remove it from models.providers.ollama.models).`;
  }
  if (PROVIDER_CACHE_CONTROL_LIMIT_RE.test(candidate)) {
    return "The AI service couldn't accept this conversation. Start a new conversation with /new, or choose another model in the Control UI.";
  }
  if (isUnsupportedReasoningEffortParameterError(candidate)) {
    return "This model endpoint does not support reasoning_effort. Set compat.supportsReasoningEffort: false on this model in your custom provider configuration and try again.";
  }
  if (candidate.length > 300 || !PROVIDER_OUTPUT_TOKEN_LIMIT_RE.test(candidate)) {
    if (!candidate || /^[{<]/u.test(candidate)) {
      return PROVIDER_SCHEMA_REJECTION_USER_TEXT;
    }
    if (candidate.startsWith("[")) {
      try {
        JSON.parse(candidate);
        return PROVIDER_SCHEMA_REJECTION_USER_TEXT;
      } catch {
        // Preserve field-path diagnostics, not truncated or suffixed JSON arrays.
        if (!/^\[[a-z_$][\w$.-]*\](?:\s|:|$)/iu.test(candidate)) {
          return PROVIDER_SCHEMA_REJECTION_USER_TEXT;
        }
      }
    }
    if (options?.includeRawFormatDetails === false) {
      return PROVIDER_SCHEMA_REJECTION_USER_TEXT;
    }
    // Redact before truncation so a clipped credential cannot escape matching.
    const detail = redactSensitiveText(candidate, { mode: "tools" })
      .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
      .trim();
    if (!detail) {
      return PROVIDER_SCHEMA_REJECTION_USER_TEXT;
    }
    const bounded = detail.length > 600 ? `${truncateUtf16Safe(detail, 600)}…` : detail;
    return `LLM request rejected: ${escapeMarkdownText(bounded)}`;
  }
  return "The reply length is set too high for this model. Lower its reply limit in the Control UI settings, or choose another model.";
}

/** Share bounded request-limit facts between live failures and persisted chat history. */
export function renderAssistantFormatFailureCopy(
  message: { errorMessage?: unknown; errorBody?: unknown; errorType?: unknown },
  reason?: FailoverReason | null,
  options?: FailureCopyOptions,
): string | undefined {
  for (const [isBody, raw] of [
    [true, message.errorBody],
    [false, message.errorMessage],
  ] as const) {
    if (typeof raw !== "string") {
      continue;
    }
    const info = parseApiErrorInfo(raw);
    if (isBody && !info?.message) {
      continue;
    }
    const status = extractErrorHttpStatus(raw)?.code;
    if (
      reason !== "format" &&
      !(
        typeof message.errorType === "string" &&
        message.errorType.toLowerCase().includes("invalid_request")
      ) &&
      !info?.type?.toLowerCase().includes("invalid_request") &&
      status !== 400 &&
      status !== 422
    ) {
      continue;
    }
    const copy = renderFormatErrorCopy(raw, options);
    if (copy !== PROVIDER_SCHEMA_REJECTION_USER_TEXT) {
      return copy;
    }
  }
  return undefined;
}

/** Render loading facts without trusting provider diagnostics or recovery instructions. */
export function renderModelLoadFailureCopy(message: {
  model?: unknown;
  errorCode?: unknown;
  errorBody?: unknown;
}): string | undefined {
  if (
    message.errorCode !== "model_load_failed" ||
    typeof message.errorBody !== "string" ||
    typeof message.model !== "string"
  ) {
    return undefined;
  }
  const contextLength = asPositiveSafeInteger(
    safeParseJsonRecord(message.errorBody)?.requestedContextLength,
  );
  const model = redactSensitiveText(message.model, { mode: "tools" })
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim();
  if (!contextLength || !model) {
    return undefined;
  }
  const label = escapeMarkdownText(truncateUtf16Safe(model, 200));
  return `Could not load model "${label}" with ${contextLength} context tokens. Wait for loading to finish on the model server, then retry, or lower the model's configured context size.`;
}

/** Classify saved error facts without loading providers or publishing their raw diagnostics. */
export function renderRecordedAssistantFailureCopy(
  message: {
    model?: unknown;
    errorMessage?: unknown;
    errorBody?: unknown;
    errorCode?: unknown;
    errorType?: unknown;
  },
  options?: FailureCopyOptions,
): string | undefined {
  const modelLoadCopy = renderModelLoadFailureCopy(message);
  if (modelLoadCopy) {
    return modelLoadCopy;
  }
  const approvalMessage = resolveExecutionApprovalFailureMessage(
    typeof message.errorMessage === "string" ? message.errorMessage : undefined,
  );
  if (approvalMessage) {
    return `⚠️ ${approvalMessage}`;
  }
  const raw = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  // Terminal lifecycle errors can already contain our safe copy without the original failure facts.
  for (const copy of Object.values(ASSISTANT_REQUEST_FAILURE_COPY)) {
    if (copy && (raw === copy || raw === `⚠️ ${copy}`)) {
      return `⚠️ ${copy}`;
    }
  }
  if (raw === "Worker inference result exceeds the transcript message limit.") {
    return "The worker could not save the model response because it exceeded the message size limit. Retry with a smaller response or continue on the Gateway. Earlier actions may have completed; verify their results before continuing.";
  }
  if (
    raw ===
    "Cloud worker could not preserve authoritative provider replay. Stop or reclaim the cloud worker, then retry locally."
  ) {
    return "The worker could not preserve the model's continuation data. Stop or reclaim the worker, then retry on the Gateway. Earlier actions may have completed; verify their results before continuing.";
  }
  const info = parseApiErrorInfo(raw);
  const code = typeof message.errorCode === "string" ? message.errorCode : info?.code;
  const status = extractErrorHttpStatus(raw)?.code;
  const classification = classifyFailoverSignalCore({
    message: raw,
    code,
    errorType: typeof message.errorType === "string" ? message.errorType : info?.type,
    status,
    details: extractFailoverSignalDetails(message.errorBody),
  });
  if (
    classification?.kind === "context_overflow" ||
    [message.errorCode, message.errorType, raw].some(
      (value) =>
        typeof value === "string" &&
        (normalizeLowercaseStringOrEmpty(value) === "context_overflow" ||
          isContextOverflowErrorFromTables(value)),
    )
  ) {
    return CONTEXT_OVERFLOW_ERROR_MESSAGE;
  }
  const formatCopy =
    !classification?.reason || classification.reason === "format"
      ? renderAssistantFormatFailureCopy(message, classification?.reason, options)
      : undefined;
  if (formatCopy) {
    return formatCopy;
  }
  const classifiedCopy = renderAssistantRequestFailureCopy({
    storageFailure: classifyGatewayStorageFailure(message),
    code,
    status,
    // The legacy timeout retry bucket also includes explicit server failures.
    reason:
      classification?.reason === "timeout" && isServerErrorMessage(raw)
        ? "server_error"
        : classification?.reason,
  });
  if (status !== undefined || (classification && classification.reason !== "timeout")) {
    return classifiedCopy;
  }
  return formatTransportErrorCopy([raw, code].filter(Boolean).join(" ")) ?? classifiedCopy;
}
