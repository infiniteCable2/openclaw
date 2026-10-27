import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";
import { resolveCompactionContextTokenBudget } from "./compaction-runtime-context.js";
import { resolveModelAsync } from "./model.js";

export type PreparedCompactionBudgetPreflight = {
  prompt: string;
  model: ProviderRuntimeModel;
  contextTokenBudget: number;
  pendingMessages?: NonNullable<
    CompactEmbeddedAgentSessionRuntimeParams["budgetPreflight"]
  >["pendingMessages"];
  onDecision?: (fits: boolean) => void;
  checkOnly?: boolean;
};

/** Capture the foreground route before any summarizer override or fallback changes it. */
export async function prepareCompactionForegroundBudget(
  params: CompactEmbeddedAgentSessionRuntimeParams,
  preparedModelRuntime: PreparedModelRuntimeSnapshot,
): Promise<PreparedCompactionBudgetPreflight | undefined> {
  if (!params.budgetPreflight) {
    return undefined;
  }
  const provider = params.provider ?? params.runtimePlan?.resolvedRef.provider ?? DEFAULT_PROVIDER;
  const modelId = params.model ?? params.runtimePlan?.resolvedRef.modelId ?? DEFAULT_MODEL;
  const suppliedModel =
    params.runtimeModel?.provider === provider && params.runtimeModel.id === modelId
      ? params.runtimeModel
      : undefined;
  const model =
    suppliedModel ??
    preparedModelRuntime.findConfiguredRuntimeModel(provider, modelId) ??
    (
      await resolveModelAsync(provider, modelId, preparedModelRuntime.agentDir, params.config, {
        preparedModelRuntime,
        workspaceDir: preparedModelRuntime.workspaceDir,
        skipAgentDiscovery: true,
        deferProviderDynamicModelPreparation: true,
        allowBundledStaticCatalogFallback: true,
        abortSignal: params.abortSignal,
      })
    ).model;
  params.abortSignal?.throwIfAborted();
  if (!model) {
    throw new Error("Foreground model metadata is unavailable for compaction budget admission");
  }
  return {
    prompt: params.budgetPreflight.prompt,
    pendingMessages: params.budgetPreflight.pendingMessages,
    onDecision: params.budgetPreflight.onDecision,
    checkOnly: params.budgetPreflight.checkOnly,
    model,
    contextTokenBudget: resolveCompactionContextTokenBudget({
      config: params.config,
      provider,
      modelId,
      model,
      requestedTokenBudget: params.contextTokenBudget,
      fallbackTokenBudget: params.tokenBudget,
    }),
  };
}
