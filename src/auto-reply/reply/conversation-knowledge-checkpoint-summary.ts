import {
  shouldCompact,
  SUMMARY_TRUNCATED_MARKER,
  type CompactionSettings,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { computeAdaptiveChunkRatioWithWorker } from "../../agents/compaction-planning-worker.js";
import {
  estimateMessagesTokens,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "../../agents/compaction-planning.js";
import { withCompleteCompactionSummary } from "../../agents/compaction-summary-coverage.js";
import { summarizeInStages } from "../../agents/compaction.js";
import { prepareCompactionBudgetPreflight } from "../../agents/embedded-agent-runner/compaction-budget-preflight.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { renderConversationKnowledgeCheckpointSummary } from "../../config/sessions/conversation-knowledge-checkpoint-context.js";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";

export type PreparedCheckpointContribution = {
  contributionId: string;
  complete: true;
  /** Complete authorized quoted text, never a partially staged packet. */
  text: string;
};

type CheckpointSummaryPlanInput = {
  contributions: readonly PreparedCheckpointContribution[];
  previousSummary?: string;
  settings: CompactionSettings;
  budget: Pick<
    Parameters<typeof prepareCompactionBudgetPreflight>[0],
    "contextTokenBudget" | "systemPrompt" | "prompt" | "toolSchemaTokens"
  >;
};

type Deferred = {
  kind: "deferred";
  reason:
    | "no-whole-prefix"
    | "oversized-contribution"
    | "summary-unavailable"
    | "summary-still-over-budget";
};
type ReadyPlan = {
  kind: "ready";
  coveredContributionIds: string[];
  retainedContributionIds: string[];
  messages: AgentMessage[];
  retainedMessages: AgentMessage[];
  estimatedTokensBefore: number;
};

/** Zero is an unspecified synthetic timestamp; do not invent historical event dates. */
function quoted(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function summaryMessage(summary: string): AgentMessage {
  return quoted(renderConversationKnowledgeCheckpointSummary(summary));
}

function pressure(params: CheckpointSummaryPlanInput, messages: AgentMessage[]) {
  return prepareCompactionBudgetPreflight({
    ...params.budget,
    messages,
    reserveTokens: params.settings.reserveTokens,
  });
}

function requiresCompaction(params: CheckpointSummaryPlanInput, messages: AgentMessage[]) {
  const decision = pressure(params, messages);
  return {
    decision,
    required: shouldCompact(decision.estimatedPromptTokens, params.budget.contextTokenBudget, {
      ...params.settings,
      reserveTokens: decision.effectiveReserveTokens,
    }),
  };
}

/** Select a whole contribution prefix; native token settings own both trigger and recent tail. */
export function planConversationKnowledgeCheckpointSummary(
  params: CheckpointSummaryPlanInput,
): ReadyPlan | Deferred | { kind: "not-needed" } {
  if (
    !Number.isFinite(params.budget.contextTokenBudget) ||
    params.budget.contextTokenBudget <= 0 ||
    !Number.isFinite(params.settings.reserveTokens) ||
    params.settings.reserveTokens < 0 ||
    !Number.isFinite(params.settings.keepRecentTokens) ||
    params.settings.keepRecentTokens < 0
  ) {
    throw new Error("Checkpoint summary requires effective native token settings");
  }
  const ids = new Set<string>();
  for (const contribution of params.contributions) {
    if (
      typeof contribution.complete !== "boolean" ||
      !contribution.complete ||
      !contribution.contributionId.trim() ||
      ids.has(contribution.contributionId) ||
      !contribution.text.trim()
    ) {
      throw new Error("Checkpoint summary requires complete unique contributions");
    }
    ids.add(contribution.contributionId);
  }
  const messages = params.contributions.map((contribution) => quoted(contribution.text));
  const all = params.previousSummary
    ? [summaryMessage(params.previousSummary), ...messages]
    : messages;
  const { decision, required } = requiresCompaction(params, all);
  if (!required) {
    return { kind: "not-needed" };
  }
  let prefixEnd = messages.length;
  let retainedTokens = 0;
  while (prefixEnd > 0 && retainedTokens < params.settings.keepRecentTokens) {
    prefixEnd--;
    retainedTokens += estimateMessagesTokens([messages[prefixEnd]!]);
  }
  if (prefixEnd === 0) {
    return { kind: "deferred", reason: "no-whole-prefix" };
  }
  return {
    kind: "ready",
    coveredContributionIds: params.contributions
      .slice(0, prefixEnd)
      .map((entry) => entry.contributionId),
    retainedContributionIds: params.contributions
      .slice(prefixEnd)
      .map((entry) => entry.contributionId),
    messages: messages.slice(0, prefixEnd),
    retainedMessages: messages.slice(prefixEnd),
    estimatedTokensBefore: decision.estimatedPromptTokens,
  };
}

function completeSummary(summary: unknown): summary is string {
  return (
    typeof summary === "string" &&
    Boolean(summary.trim()) &&
    summary.trim() !== "No prior history." &&
    !summary.includes("[Partial summary:") &&
    !summary.includes(SUMMARY_TRUNCATED_MARKER)
  );
}

/** Produce a candidate only. The owner revalidates source grants and commits coverage separately. */
export async function prepareConversationKnowledgeCheckpointSummary(
  params: CheckpointSummaryPlanInput & {
    native: Omit<
      Parameters<typeof summarizeInStages>[0],
      "messages" | "previousSummary" | "maxChunkTokens"
    >;
    /** Already resolved configured native provider, if any; no registry/auth discovery here. */
    provider?: CompactionProvider;
  },
): Promise<
  | Exclude<ReturnType<typeof planConversationKnowledgeCheckpointSummary>, ReadyPlan>
  | {
      kind: "candidate";
      summary: string;
      coveredContributionIds: string[];
      retainedContributionIds: string[];
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
    }
> {
  const { native } = params;
  native.signal.throwIfAborted();
  const plan = planConversationKnowledgeCheckpointSummary(params);
  if (plan.kind !== "ready") {
    return plan;
  }
  if (
    !Number.isFinite(native.contextWindow) ||
    native.contextWindow <= 0 ||
    !Number.isFinite(native.reserveTokens) ||
    native.reserveTokens <= 0
  ) {
    throw new Error("Checkpoint summary requires resolved native summarizer budgets");
  }
  let summary: string | undefined;
  if (params.provider) {
    try {
      summary = await withCompleteCompactionSummary(() =>
        params.provider!.summarize({
          messages: plan.messages,
          previousSummary: params.previousSummary,
          signal: native.signal,
          customInstructions: native.customInstructions,
          summarizationInstructions: native.summarizationInstructions,
        }),
      );
    } catch {
      native.signal.throwIfAborted();
      // Match native provider fallback; no incomplete provider coverage is committed.
      summary = undefined;
    }
  }
  native.signal.throwIfAborted();
  if (summary === undefined || !completeSummary(summary)) {
    const previousTokens = params.previousSummary
      ? estimateMessagesTokens([summaryMessage(params.previousSummary)])
      : 0;
    const available =
      native.contextWindow -
      native.reserveTokens -
      SUMMARIZATION_OVERHEAD_TOKENS -
      Math.ceil(previousTokens * SAFETY_MARGIN);
    // Native chunking preserves whole messages. An indivisible oversized contribution
    // must remain pending instead of invoking its lossy oversized-message fallback.
    if (
      available <= 0 ||
      plan.messages.some(
        (message) => Math.ceil(estimateMessagesTokens([message]) * SAFETY_MARGIN) > available,
      )
    ) {
      return { kind: "deferred", reason: "oversized-contribution" };
    }
    const ratio = await computeAdaptiveChunkRatioWithWorker({
      messages: plan.messages,
      contextWindow: native.contextWindow,
      signal: native.signal,
    });
    const maxChunkTokens = Math.max(
      1,
      Math.min(available, Math.floor(native.contextWindow * ratio) - SUMMARIZATION_OVERHEAD_TOKENS),
    );
    summary = await withCompleteCompactionSummary(() =>
      summarizeInStages({
        ...native,
        messages: plan.messages,
        previousSummary: params.previousSummary,
        maxChunkTokens,
      }),
    );
  }
  native.signal.throwIfAborted();
  if (!completeSummary(summary)) {
    return { kind: "deferred", reason: "summary-unavailable" };
  }
  const after = requiresCompaction(params, [summaryMessage(summary), ...plan.retainedMessages]);
  if (after.required || after.decision.estimatedPromptTokens >= plan.estimatedTokensBefore) {
    return { kind: "deferred", reason: "summary-still-over-budget" };
  }
  return {
    kind: "candidate",
    summary,
    coveredContributionIds: plan.coveredContributionIds,
    retainedContributionIds: plan.retainedContributionIds,
    estimatedTokensBefore: plan.estimatedTokensBefore,
    estimatedTokensAfter: after.decision.estimatedPromptTokens,
  };
}
