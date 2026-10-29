import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { createPreparedEmbeddedAgentSettingsManager } from "../../agents/agent-project-settings.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import {
  resolveCompactionContextTokenBudget,
  resolveEmbeddedCompactionThinkingLevel,
} from "../../agents/embedded-agent-runner/compaction-runtime-context.js";
import { projectModelThinkingCompat } from "../../agents/model-catalog-lookup.js";
import { completeWithPreparedSimpleCompletionModel } from "../../agents/simple-completion-execution.js";
import { acquireSimpleCompletionModelForAgent } from "../../agents/simple-completion-runtime.js";
import { requiredWorkerHelperError } from "../../config/required-worker-profile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getCompactionProvider } from "../../plugins/compaction-provider.js";
import {
  planConversationKnowledgeCheckpointSummary,
  prepareConversationKnowledgeCheckpointSummary,
  type PreparedCheckpointContribution,
} from "./conversation-knowledge-checkpoint-summary.js";

/** Native model/auth custody for background summaries; never opens a conversation or exposes tools. */
export async function acquireConversationKnowledgeCheckpointModel(params: {
  config: OpenClawConfig;
  agentId: string;
  signal: AbortSignal;
  assertCurrent(): void;
  retainCleanup?(release: () => Promise<void>): void;
}) {
  const { config, agentId } = params;
  params.assertCurrent();
  const blocked = requiredWorkerHelperError(config);
  if (blocked) throw new Error(blocked.error);
  const primary = await acquireSimpleCompletionModelForAgent({
    cfg: config,
    agentId,
    signal: params.signal,
  });
  if ("error" in primary) throw new Error("Checkpoint primary model is unavailable");
  let summaryModel: typeof primary = primary;
  let disposed = false;
  let primaryReleased = false;
  let summaryReleased = true;
  const release = async () => {
    disposed = true;
    const failures: unknown[] = [];
    try {
      if (!summaryReleased) {
        await summaryModel[Symbol.asyncDispose]();
        summaryReleased = true;
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!primaryReleased) {
        await primary[Symbol.asyncDispose]();
        primaryReleased = true;
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, "Checkpoint model cleanup remains pending");
  };
  params.retainCleanup?.(release);
  try {
    params.assertCurrent();
    params.signal.throwIfAborted();
    const contextTokenBudget = resolveCompactionContextTokenBudget({
      config,
      provider: primary.model.provider,
      modelId: primary.model.id,
      model: primary.model,
    });
    const settings = createPreparedEmbeddedAgentSettingsManager({
      cwd: resolveAgentWorkspaceDir(config, agentId),
      agentDir: primary.selection.agentDir,
      cfg: config,
      contextTokenBudget,
    }).getCompactionSettings();
    const override = config.agents?.defaults?.compaction?.model?.trim();
    if (override) {
      const selected = await acquireSimpleCompletionModelForAgent({
        cfg: config,
        agentId,
        modelRef: override,
        signal: params.signal,
      });
      if ("error" in selected) throw new Error("Checkpoint compaction model is unavailable");
      summaryModel = selected;
      summaryReleased = false;
    }
    params.assertCurrent();
    params.signal.throwIfAborted();
    const contextWindow = resolveCompactionContextTokenBudget({
      config,
      provider: summaryModel.model.provider,
      modelId: summaryModel.model.id,
      model: summaryModel.model,
    });
    const summarySettings = createPreparedEmbeddedAgentSettingsManager({
      cwd: resolveAgentWorkspaceDir(config, agentId),
      agentDir: summaryModel.selection.agentDir,
      cfg: config,
      contextTokenBudget: contextWindow,
    }).getCompactionSettings();
    const thinkingLevel = resolveEmbeddedCompactionThinkingLevel({
      config,
      provider: summaryModel.model.provider,
      modelId: summaryModel.model.id,
      catalog: [
        {
          provider: summaryModel.model.provider,
          id: summaryModel.model.id,
          api: summaryModel.model.api,
          reasoning: summaryModel.model.reasoning,
          thinkingLevelMap: summaryModel.model.thinkingLevelMap,
          params: summaryModel.model.params,
          compat: projectModelThinkingCompat(summaryModel.model.compat),
        },
      ],
      agentId,
      agentRuntime: "openclaw",
    });
    const providerId = config.agents?.defaults?.compaction?.provider?.trim();
    const provider = providerId ? getCompactionProvider(providerId) : undefined;
    const budget = { contextTokenBudget, prompt: "" };
    const assertCurrent = () => {
      if (disposed) throw new Error("Checkpoint model custody has ended");
      params.assertCurrent();
    };
    return {
      contextTokenBudget,
      settings,
      planning: { settings, budget },
      plan(input: {
        contributions: readonly PreparedCheckpointContribution[];
        previousSummary?: string;
      }) {
        assertCurrent();
        return planConversationKnowledgeCheckpointSummary({ ...input, settings, budget });
      },
      async summarize(input: {
        contributions: readonly PreparedCheckpointContribution[];
        previousSummary?: string;
        signal: AbortSignal;
        assertCurrent(): void;
      }) {
        const check = () => {
          assertCurrent();
          input.assertCurrent();
          input.signal.throwIfAborted();
        };
        check();
        const result = await prepareConversationKnowledgeCheckpointSummary({
          ...input,
          settings,
          budget,
          provider,
          native: {
            model: summaryModel.model,
            // The native prepared completion owns credentials; this adapter never copies them.
            apiKey: "",
            signal: input.signal,
            contextWindow,
            reserveTokens: summarySettings.reserveTokens,
            summarizationInstructions: {
              identifierPolicy: config.agents?.defaults?.compaction?.identifierPolicy,
            },
            streamFn: async (_model, context, options) => {
              check();
              const message = await completeWithPreparedSimpleCompletionModel({
                model: summaryModel.model,
                auth: summaryModel.auth,
                cfg: config,
                context,
                assertCurrent: check,
                options: {
                  signal: options?.signal
                    ? AbortSignal.any([input.signal, options.signal])
                    : input.signal,
                  maxTokens: options?.maxTokens,
                  temperature: options?.temperature,
                  headers: options?.headers,
                  reasoning: thinkingLevel,
                },
              });
              check();
              const stream = createAssistantMessageEventStream();
              if (message.stopReason === "error" || message.stopReason === "aborted") {
                stream.push({ type: "error", reason: message.stopReason, error: message });
              } else {
                stream.push({ type: "done", reason: message.stopReason, message });
              }
              stream.end();
              return stream;
            },
          },
        });
        check();
        return result;
      },
      [Symbol.asyncDispose]: release,
    };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Checkpoint model preparation failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

export type ConversationKnowledgeCheckpointModel = Awaited<
  ReturnType<typeof acquireConversationKnowledgeCheckpointModel>
>;
