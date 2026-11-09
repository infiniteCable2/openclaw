import { expectDefined } from "@openclaw/normalization-core";
import {
  hasNonEmptyString,
  normalizeLowercaseStringOrEmpty,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
} from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { CliCredentialRemovedError } from "../../agents/cli-runner/auth-profile-preparation-error.js";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  renderAgentHarnessPreflightUserMessage,
  renderUserFacingText,
} from "../../agents/embedded-agent-helpers/user-facing-text.js";
import { classifyCompactionReason } from "../../agents/embedded-agent-runner/compact-reasons.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  findCliTerminalStopError,
  findCliTimeoutError,
  isFailoverError,
  isNonProviderRuntimeCoordinationError,
} from "../../agents/failover-error.js";
import {
  renderAssistantRequestFailureCopy,
  renderRuntimeCoordinationFailureCopy,
} from "../../agents/failover/assistant-request-failure-copy.js";
import { classifyFailoverReason } from "../../agents/failover/classify.js";
import {
  ContextPreparationTimeoutError,
  findLocalWorkerTaskFailure,
} from "../../agents/failover/local-preparation-error.js";
import { resolveExecutionApprovalFailureMessage } from "../../agents/failover/message-patterns.js";
import { resolveReplyFailoverFacts } from "../../agents/failover/request-error-facts.js";
import {
  renderAuthProfileFailoverCopy,
  renderBillingReplyCopy,
  renderCliTimeoutReplyCopy,
  renderCodexAppServerFailureCopy,
  renderFailoverCodeUserCopy,
  renderMissingApiKeyReplyCopy,
  renderRateLimitOrOverloadedCopy,
  renderRateLimitReplyCopy,
  type ReplyFallbackAttempt,
} from "../../agents/failover/user-copy.js";
import { isAgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { isProviderAuthError } from "../../agents/model-auth-runtime-shared.js";
import { buildProviderAuthRecoveryHint } from "../../agents/provider-auth-recovery-hint.js";
import {
  createMissingReplyNotice,
  MISSING_REPLY_NOTICE_TEXT,
  resolveReplyExpectation,
  shouldDeliverMissingReplyNotice,
  type ReplyExpectation,
} from "../../agents/reply-completion.js";
import {
  collectErrorGraphCandidates,
  formatErrorMessage,
  readErrorCauses,
} from "../../infra/errors.js";
import { resolveUserMessageLocale } from "../../shared/language.js";
import { formatInlineCodeSpan } from "../../shared/markdown-code.js";
import { resolveUserMessages } from "../../shared/user-messages.js";
import { SkillResourceDeliveryLimitError } from "../../skills/runtime/resource-delivery-error.js";
import { buildProviderLoginRecovery } from "../provider-login-recovery.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";

type ReplyFailoverFacts = ReturnType<typeof resolveReplyFailoverFacts>;

/** Preserve successful content and formatted tool errors while normalizing terminal provider copy. */
export function normalizeAgentRunFailurePayloads(
  runResult: Pick<EmbeddedAgentRunResult, "payloads" | "meta">,
  language?: string,
): void {
  const hasNonErrorContent = runResult.payloads?.some(
    (p) => !p.isError && !p.isReasoning && hasOutboundReplyContent(p, { trimText: true }),
  );
  if (!hasNonErrorContent) {
    const providerFailure = runResult.payloads
      ?.filter((payload) => payload.isError)
      .map((payload) => getReplyPayloadMetadata(payload)?.providerFailure)
      .find((failure) => failure?.rateLimitRetriesExhausted !== undefined);
    const metaErrorMsg = runResult.meta?.error?.message ?? "";
    const rawErrorPayloadText =
      runResult.payloads?.find(
        (p) => p.isError && hasNonEmptyString(p.text) && !p.text.startsWith("⚠️"),
      )?.text ?? "";
    const errorCandidate = metaErrorMsg || rawErrorPayloadText;
    const candidateReason =
      providerFailure?.reason ?? (errorCandidate ? classifyFailoverReason(errorCandidate) : null);
    const formattedErrorCandidate =
      candidateReason === "rate_limit" || candidateReason === "overloaded"
        ? resolveUserMessageLocale(language) !== "en"
          ? `⚠️ ${resolveUserMessages(language).requestFailure[candidateReason]}`
          : renderRateLimitOrOverloadedCopy({
              reason: candidateReason,
              raw: errorCandidate,
              rateLimitRetriesExhausted: providerFailure?.rateLimitRetriesExhausted,
            })
        : undefined;
    if (formattedErrorCandidate) {
      runResult.payloads = [
        markAgentRunFailureReplyPayload({
          text: formattedErrorCandidate,
          isError: true,
        }),
      ];
    }
  }
}

function readFallbackAttempts(error: unknown): readonly ReplyFallbackAttempt[] {
  return isFailoverError(error) && Array.isArray(error.attempts) ? error.attempts : [];
}

export function resolveReplyFailureSummary(params: {
  language?: string;
  error: unknown;
  message: string;
  reason: ReplyFailoverFacts["reason"];
  attempts?: readonly ReplyFallbackAttempt[];
}): { kind: "billing" | "rate_limit" | "overloaded"; text: string } | undefined {
  const attempts = params.attempts;
  let kind = params.reason;
  // The top-level reason describes the last attempt; aggregate copy must account for the entire chain.
  if (attempts?.length) {
    if (attempts.some((attempt) => attempt.reason === "billing")) {
      kind = "billing";
    } else if (attempts.every((attempt) => attempt.reason === "overloaded")) {
      kind = "overloaded";
    } else {
      kind = attempts.every(
        (attempt) => attempt.reason === "rate_limit" || attempt.reason === "overloaded",
      )
        ? "rate_limit"
        : undefined;
    }
  }
  if (kind !== "billing" && kind !== "rate_limit" && kind !== "overloaded") {
    return undefined;
  }
  if (resolveUserMessageLocale(params.language) !== "en") {
    return { kind, text: `⚠️ ${resolveUserMessages(params.language).requestFailure[kind]}` };
  }
  const failoverError = isFailoverError(params.error) ? params.error : undefined;
  const text =
    kind === "billing"
      ? renderBillingReplyCopy({
          attempts,
          provider: failoverError?.provider,
          model: failoverError?.model,
          authMode: failoverError?.authMode,
        })
      : kind === "overloaded"
        ? renderRateLimitOrOverloadedCopy({ reason: kind, raw: params.message })
        : renderRateLimitReplyCopy({
            message: params.message,
            reason: params.reason,
            attempts,
            provider: failoverError?.provider,
            code: failoverError?.code,
            rateLimitRetriesExhausted: failoverError?.rateLimitRetriesExhausted,
            cooldownExpiry: failoverError?.soonestCooldownExpiry,
            sanitizeText: (rawText) => sanitizeUserFacingText(rawText, { errorContext: true }),
          });
  return { kind, text };
}

function collapseRepeatedFailureDetail(message: string): string {
  const parts = message
    .split(/\s+\|\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2 && parts.every((part) => part === parts[0])) {
    return expectDefined(parts[0], "parts entry at 0");
  }
  return message.trim();
}

const EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS = 900;
const PREFLIGHT_COMPACTION_FAILURE_PREFIX = "Preflight compaction required but failed:";

type ExternalRunFailureReply = Pick<ReplyPayload, "text" | "presentation"> & {
  text: string;
  isGenericRunnerFailure: boolean;
};

type ExternalRunFailureInput = string | { message: string; error?: unknown };

type ExternalFailureConversationContext = Pick<
  TemplateContext,
  "ChatType" | "Provider" | "SessionKey" | "Surface"
>;

export function isNonDirectConversationContext(ctx: ExternalFailureConversationContext): boolean {
  const chatType = normalizeLowercaseStringOrEmpty(ctx.ChatType);
  return chatType === "group" || chatType === "channel";
}

export function isVerboseFailureDetailEnabled(level: VerboseLevel | undefined): boolean {
  return level === "on" || level === "full";
}

export function buildPreflightCompactionFailureText(
  message: string,
  options?: { includeDetails?: boolean },
): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  if (!normalizedMessage.startsWith(PREFLIGHT_COMPACTION_FAILURE_PREFIX)) {
    return null;
  }
  const reason = renderUserFacingText(
    normalizedMessage.slice(PREFLIGHT_COMPACTION_FAILURE_PREFIX.length),
    { errorContext: true },
  )
    .trim()
    .replace(/\s+/gu, " ");
  const classification = classifyCompactionReason(reason);
  if (classification === "unshrinkable_request") {
    return `⚠️ ${reason}`;
  }
  const isTimeout = classification === "timeout";
  const reasonSuffix = options?.includeDetails && reason && !isTimeout ? ` Reason: ${reason}.` : "";
  const summary = isTimeout
    ? "⚠️ This conversation is too long, and shortening it took too long."
    : "⚠️ This conversation is too long, and OpenClaw couldn't shorten it.";
  return `${summary}${reasonSuffix} Try again, use /compact, or use /new to start a fresh session.`;
}

export function buildAuthProfileFailoverFailureText(error: unknown): string | null {
  if (!isFailoverError(error) || !error.provider || !error.authProfileFailure) {
    return null;
  }
  return renderAuthProfileFailoverCopy({
    reason: error.reason,
    provider: error.provider,
    allInCooldown: error.authProfileFailure.allInCooldown,
    recoveryHint: buildProviderAuthRecoveryHint({ provider: error.provider }),
  });
}

function formatForwardedExternalRunFailureText(message: string, language?: string): string {
  const sanitized = message
    .trim()
    .replace(/^⚠️\s*/u, "")
    .replace(/\s+/gu, " ");
  const detail =
    sanitized.length > EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS
      ? `${truncateUtf16Safe(sanitized, EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS - 1).trimEnd()}…`
      : sanitized || undefined;
  return detail
    ? resolveUserMessages(language).replyDiagnosticFailure(detail)
    : resolveUserMessages(language).replyUnavailable;
}

export function buildExternalRunFailureReply(
  input: ExternalRunFailureInput,
  options?: {
    language?: string;
    includeAuthProfileId?: boolean;
    includeDetails?: boolean;
    replayPrevented?: boolean;
    failoverFacts?: ReplyFailoverFacts;
  },
): ExternalRunFailureReply {
  const messages = resolveUserMessages(options?.language);
  const message = typeof input === "string" ? input : input.message;
  const error = typeof input === "string" ? undefined : input.error;
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  const removedCredential = collectErrorGraphCandidates(error, readErrorCauses).find(
    (candidate) => candidate instanceof CliCredentialRemovedError,
  );
  if (removedCredential) {
    return {
      text: `⚠️ ${removedCredential.userMessage(options?.includeAuthProfileId)}`,
      isGenericRunnerFailure: false,
    };
  }
  const buildUnclassifiedReply = (): ExternalRunFailureReply => {
    const sanitizedMessage = sanitizeUserFacingText(normalizedMessage, { errorContext: true });
    return {
      text: options?.includeDetails
        ? formatForwardedExternalRunFailureText(sanitizedMessage, options?.language)
        : messages.replyUnavailable,
      isGenericRunnerFailure: true,
    };
  };
  const approvalMessage = resolveExecutionApprovalFailureMessage(normalizedMessage);
  if (approvalMessage) {
    return { text: `⚠️ ${approvalMessage}`, isGenericRunnerFailure: false };
  }
  if (
    collectErrorGraphCandidates(error, readErrorCauses).some(
      (candidate) => candidate instanceof SkillResourceDeliveryLimitError,
    )
  ) {
    return {
      text: "⚠️ Selected skill resources exceed the 8 MiB delivery limit. Select fewer skills, then try again.",
      isGenericRunnerFailure: false,
    };
  }
  // A preflight refusal is host-authored and names the next step;
  // raw thrown detail further below stays verbose-gated.
  if (isAgentHarnessPreflightError(error)) {
    const userMessage = renderAgentHarnessPreflightUserMessage(error);
    if (userMessage !== undefined) {
      return {
        text: userMessage,
        isGenericRunnerFailure: false,
      };
    }
    return buildUnclassifiedReply();
  }
  const localFailure = findLocalWorkerTaskFailure(error);
  if (localFailure) {
    return {
      text:
        localFailure.code === "overloaded"
          ? "OpenClaw's local workers are at capacity. Check the conversation for completed work before trying again."
          : localFailure instanceof ContextPreparationTimeoutError
            ? localFailure.message
            : "A local worker task timed out. Please try again.",
      isGenericRunnerFailure: false,
    };
  }
  const failoverFacts =
    options?.failoverFacts ??
    resolveReplyFailoverFacts(error ?? normalizedMessage, normalizedMessage);
  const failoverCodeCopy = renderFailoverCodeUserCopy(failoverFacts.code);
  if (failoverCodeCopy) {
    return { text: failoverCodeCopy, isGenericRunnerFailure: false };
  }
  const runtimeCoordinationFailure =
    failoverFacts.code && isNonProviderRuntimeCoordinationError(error)
      ? renderRuntimeCoordinationFailureCopy(failoverFacts.code, options?.language)
      : undefined;
  if (runtimeCoordinationFailure) {
    return { text: runtimeCoordinationFailure, isGenericRunnerFailure: false };
  }
  const oauthRefreshFailure =
    classifyOAuthRefreshFailureError(error) ?? classifyOAuthRefreshFailure(normalizedMessage);
  const providerLoginRecovery = buildProviderLoginRecovery({
    provider: oauthRefreshFailure
      ? (oauthRefreshFailure.provider ?? undefined)
      : failoverFacts.provider,
    oauthReason: oauthRefreshFailure?.reason,
    failoverReason: failoverFacts.reason,
    authMode: failoverFacts.authMode,
  });
  if (oauthRefreshFailure) {
    const loginCommand = buildOAuthRefreshFailureLoginCommand(oauthRefreshFailure.provider, {
      profileId: options?.includeAuthProfileId ? oauthRefreshFailure.profileId : undefined,
    });
    const loginCommandMarkdown = formatInlineCodeSpan(loginCommand);
    const providerText = oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : "";
    const retryLoginHint = providerLoginRecovery
      ? "send `/login` from a private chat or Control UI session to choose a provider, or re-auth"
      : "re-auth";
    if (oauthRefreshFailure.reason) {
      return {
        text: providerLoginRecovery
          ? `⚠️ ${providerLoginRecovery.hint} You can also re-auth with ${loginCommandMarkdown} on the gateway.`
          : `⚠️ Model login expired on the gateway${providerText}. Re-auth with ${loginCommandMarkdown} in a terminal, then try again.`,
        ...(providerLoginRecovery ? { presentation: providerLoginRecovery.presentation } : {}),
        isGenericRunnerFailure: false,
      };
    }
    return {
      text: `⚠️ Model login failed on the gateway${providerText}. Please try again. If this keeps happening, ${retryLoginHint} with ${loginCommandMarkdown} in a terminal.`,
      isGenericRunnerFailure: false,
    };
  }
  const authProfileFailoverFailure = buildAuthProfileFailoverFailureText(error);
  if (authProfileFailoverFailure) {
    return {
      text: providerLoginRecovery
        ? `${providerLoginRecovery.hint}\n\n${authProfileFailoverFailure}`
        : authProfileFailoverFailure,
      ...(providerLoginRecovery ? { presentation: providerLoginRecovery.presentation } : {}),
      isGenericRunnerFailure: false,
    };
  }
  const cliTerminalStopError = findCliTerminalStopError(error);
  if (cliTerminalStopError) {
    return {
      text: renderUserFacingText(cliTerminalStopError.message, { errorContext: true }),
      isGenericRunnerFailure: false,
    };
  }
  const cliTimeoutError = findCliTimeoutError(error);
  const cliBackendTimeoutFailure = renderCliTimeoutReplyCopy({
    message: normalizedMessage,
    cliTimeout: cliTimeoutError?.cliTimeout,
    provider: cliTimeoutError?.provider,
    replayPrevented: options?.replayPrevented,
  });
  if (cliBackendTimeoutFailure) {
    return { text: cliBackendTimeoutFailure, isGenericRunnerFailure: false };
  }
  if (isFailoverError(error) && error.rateLimitRetriesExhausted !== undefined) {
    const summary = resolveReplyFailureSummary({
      language: options?.language,
      error,
      message,
      reason: failoverFacts.reason,
      attempts: error.attempts,
    });
    if (summary) {
      return { text: summary.text, isGenericRunnerFailure: false };
    }
  }
  const providerRequestError = failoverFacts.providerRequestError;
  if (providerRequestError) {
    // Curated facet copy carries recovery guidance (quota/billing ambiguity,
    // /new for conversation-state, config fix for model_not_found); the
    // classified summary below is the fallback for facts without a facet.
    return {
      text:
        resolveUserMessageLocale(options?.language) === "en"
          ? providerRequestError.userMessage
          : (renderAssistantRequestFailureCopy({ ...failoverFacts, language: options?.language }) ??
            providerRequestError.userMessage),
      isGenericRunnerFailure: false,
    };
  }
  const authError = isProviderAuthError(error) ? error : undefined;
  const missingApiKeyFailure = renderMissingApiKeyReplyCopy(
    authError
      ? { provider: authError.provider, providerGuidance: authError.providerGuidance }
      : undefined,
  );
  if (missingApiKeyFailure) {
    return { text: missingApiKeyFailure, isGenericRunnerFailure: false };
  }
  const codexAppServerFailure = renderCodexAppServerFailureCopy(normalizedMessage);
  if (codexAppServerFailure) {
    return { text: codexAppServerFailure, isGenericRunnerFailure: false };
  }
  const classifiedFailure =
    resolveUserMessageLocale(options?.language) === "en"
      ? (failoverFacts.requestFailureText ?? renderAssistantRequestFailureCopy(failoverFacts))
      : renderAssistantRequestFailureCopy({ ...failoverFacts, language: options?.language });
  if (classifiedFailure) {
    return { text: classifiedFailure, isGenericRunnerFailure: false };
  }
  // Only unclassified thrown text reaches this branch. Verbose mode is the
  // explicit opt-in because sanitization does not make raw provider bodies safe.
  return {
    text: options?.includeDetails
      ? formatForwardedExternalRunFailureText(
          renderUserFacingText(normalizedMessage, { errorContext: true }),
          options?.language,
        )
      : messages.replyUnavailable,
    isGenericRunnerFailure: true,
  };
}

export function markAgentRunFailureReplyPayload<T extends ReplyPayload>(payload: T): T {
  const marked = markReplyPayloadForSourceSuppressionDelivery(payload);
  marked.isError = true;
  return marked;
}

export function markPostCompactionModelFailurePayload(
  postCompactionModelFailure: true | undefined,
  payload: ReplyPayload,
): ReplyPayload {
  return postCompactionModelFailure === true &&
    payload.isError === true &&
    isReplyPayloadTerminalContent(payload) &&
    payload.text !== undefined
    ? setReplyPayloadMetadata(payload, { postCompactionModelFailure: true })
    : payload;
}

export function renderPostCompactionModelFailurePayload(
  payload: ReplyPayload,
  language?: string,
): ReplyPayload {
  return getReplyPayloadMetadata(payload)?.postCompactionModelFailure === true &&
    payload.text !== undefined
    ? copyReplyPayloadMetadata(payload, {
        ...payload,
        text: `${resolveUserMessages(language).replyPostCompactionFailed} ${payload.text.replace(/^⚠️\s*/u, "")}`,
      })
    : payload;
}

/** Optional silence hides generic boilerplate, not guidance or the outcome of visible work. */
export function resolveAgentRunFailureText(params: {
  text: string;
  replyExpectation: ReplyExpectation;
  isGenericRunnerFailure: boolean;
  visibleReplyDelivered: boolean;
}): string {
  return params.replyExpectation === "optional" &&
    params.isGenericRunnerFailure &&
    !params.visibleReplyDelivered
    ? ""
    : params.text;
}

export function buildTerminalAgentRunFailureReplyPayload(params: {
  language?: string;
  isHeartbeat?: boolean;
  useHeartbeatFailureCopy?: boolean;
  replyExpectation: ReplyExpectation;
  visibleReplyDelivered: boolean;
}): ReplyPayload {
  return markAgentRunFailureReplyPayload({
    text: resolveAgentRunFailureText({
      ...params,
      text: resolveUserMessages(params.language).replyUnavailable,
      isGenericRunnerFailure: true,
    }),
  });
}

/** Lifts the owned failure notice without inventing chat output for a background empty turn. */
export async function resolveTerminalAgentRunFailurePayload(params: {
  language?: string;
  result: EmbeddedAgentRunResult;
  run: Parameters<typeof shouldDeliverMissingReplyNotice>[0];
  visibleReplyDelivered: () => Promise<boolean>;
}): Promise<ReplyPayload | undefined> {
  const terminalError = params.result.meta?.error;
  const missingReplyNotice =
    terminalError?.kind === "incomplete_turn" &&
    terminalError.message.startsWith(MISSING_REPLY_NOTICE_TEXT);
  const suppressMissingReplyNotice =
    missingReplyNotice && !shouldDeliverMissingReplyNotice(params.run);
  const ownedFailureNotice = params.result.payloads?.find(
    (payload) =>
      payload.isError === true &&
      payload.isStatusNotice === true &&
      getReplyPayloadMetadata(payload)?.assistantTranscriptOwned === true,
  );
  if (ownedFailureNotice) {
    params.result.payloads = params.result.payloads?.filter(
      (payload) => payload !== ownedFailureNotice,
    );
    return suppressMissingReplyNotice
      ? undefined
      : markAgentRunFailureReplyPayload(ownedFailureNotice);
  }
  if (suppressMissingReplyNotice) {
    return undefined;
  }
  if (missingReplyNotice) {
    return markAgentRunFailureReplyPayload(createMissingReplyNotice(terminalError.message));
  }
  const replyExpectation = resolveReplyExpectation(params.run);
  return buildTerminalAgentRunFailureReplyPayload({
    language: params.language,
    replyExpectation,
    visibleReplyDelivered:
      replyExpectation === "optional" ? await params.visibleReplyDelivered() : false,
  });
}

export function buildKnownAgentRunFailureReplyPayload(params: {
  language?: string;
  err: unknown;
  sessionCtx: TemplateContext;
  resolvedVerboseLevel: VerboseLevel | undefined;
}): ReplyPayload | undefined {
  // Preflight diagnostics are not provider failures. Only explicit public copy
  // can bypass the caller's diagnostic disclosure policy.
  const message = formatErrorMessage(params.err);
  if (isAgentHarnessPreflightError(params.err) || findLocalWorkerTaskFailure(params.err)) {
    const reply = buildExternalRunFailureReply(
      {
        message,
        error: params.err,
      },
      { language: params.language },
    );
    return reply.isGenericRunnerFailure
      ? undefined
      : markAgentRunFailureReplyPayload({ text: reply.text });
  }
  const failoverFacts = resolveReplyFailoverFacts(params.err, message);
  const failureSummary = resolveReplyFailureSummary({
    language: params.language,
    error: params.err,
    message,
    reason: failoverFacts.reason,
    attempts: readFallbackAttempts(params.err),
  });
  const knownFailureText =
    failureSummary?.kind === "billing"
      ? failureSummary.text
      : (buildPreflightCompactionFailureText(message, {
          includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
        }) ?? failureSummary?.text);
  const externalRunFailureReply: ExternalRunFailureReply = knownFailureText
    ? { text: knownFailureText, isGenericRunnerFailure: false }
    : buildExternalRunFailureReply(
        { message, error: params.err },
        {
          language: params.language,
          includeAuthProfileId: !isNonDirectConversationContext(params.sessionCtx),
          includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
          failoverFacts,
        },
      );
  if (externalRunFailureReply.isGenericRunnerFailure) {
    return undefined;
  }
  return markAgentRunFailureReplyPayload({
    text: externalRunFailureReply.text,
    ...(externalRunFailureReply.presentation
      ? { presentation: externalRunFailureReply.presentation }
      : {}),
  });
}
