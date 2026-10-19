import {
  preserveCompactionReplayWindow,
  resolveCompactionReplayEligibility,
} from "@openclaw/ai/transports";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../agent-project-settings.js";
import { sanitizeToolUseResultPairingForModel } from "../session-transcript-repair.js";
import type { AgentSession, SessionManager } from "../sessions/index.js";
import type { SettingsManager } from "../sessions/settings-manager.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";
import { prepareCompactionBudgetPreflight } from "./compaction-budget-preflight.js";
import { dedupeDuplicateUserMessagesForCompaction } from "./compaction-duplicate-user-messages.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import { sanitizeSessionHistory, validateReplayTurns } from "./replay-history.js";
import { estimateToolSchemaTokenPressure } from "./run/preemptive-compaction.js";

/** Prepare the native compaction prompt view before admitting summary work or hooks. */
export async function prepareCompactionPromptContext(input: {
  runtime: PreparedCompactionRuntime;
  session: AgentSession;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  systemPrompt: string;
  transcriptPolicy: TranscriptPolicy;
  responsesApi: boolean;
  compactionReplayEnabled: boolean;
  assertActive: SessionSourceAssertion;
}) {
  const { runtime, session, transcriptPolicy, compactionReplayEnabled, assertActive } = input;
  const { params, effectiveModel, modelId, provider, effectiveWorkspace, runtimePlan } = runtime;
  const replayContext = {
    modelApi: effectiveModel.api,
    modelId,
    provider,
    config: params.config,
    workspaceDir: effectiveWorkspace,
    env: process.env,
    model: effectiveModel,
    sessionId: params.sessionId,
    policy: transcriptPolicy,
  };
  const prior = await sanitizeSessionHistory({
    ...replayContext,
    messages: session.messages,
    allowedToolNames: runtime.allowedToolNames,
    sessionManager: input.sessionManager,
    preserveLatestAssistantThinking: false,
  });
  assertActive();
  const validated = await validateReplayTurns({ ...replayContext, messages: prior });
  assertActive();
  // Metrics and limiting consume the same validated view, even without a history limit.
  session.agent.state.messages = dedupeDuplicateUserMessagesForCompaction(validated);
  const originalMessages = session.messages.slice();
  const truncated = preserveCompactionReplayWindow(
    originalMessages,
    limitHistoryTurns(
      session.messages,
      getHistoryLimitFromSessionKey(params.sessionKey, params.config, {
        accountId: params.agentAccountId,
        peerId: params.conversationRoutePeerId,
        chatType: params.chatType,
      }),
    ),
    effectiveModel,
    {
      sessionId: params.sessionId,
      authProfileId: runtimePlan.auth.forwardedAuthProfileId,
      enabled: compactionReplayEnabled,
    },
  );
  // History limiting can remove the assistant that owns a retained tool result.
  const limited = transcriptPolicy.repairToolUseResultPairing
    ? sanitizeToolUseResultPairingForModel(truncated, input.responsesApi)
    : truncated;
  if (limited.length > 0) {
    session.agent.state.messages = limited;
  }
  const foreground = params.budgetPreflight;
  if (!foreground) {
    return { originalMessages, skipCompaction: false };
  }
  const foregroundSettings =
    foreground.contextTokenBudget === runtime.contextTokenBudget
      ? input.settingsManager
      : createPreparedEmbeddedAgentSettingsManager({
          cwd: runtime.effectiveCwd,
          agentDir: runtime.agentDir,
          cfg: params.config,
          pluginMetadataSnapshot: getCurrentPluginMetadataSnapshot({
            config: params.config,
            env: process.env,
            workspaceDir: effectiveWorkspace,
          }),
          contextTokenBudget: foreground.contextTokenBudget,
        });
  const pressure = prepareCompactionBudgetPreflight({
    messages: session.messages,
    systemPrompt: input.systemPrompt,
    prompt: foreground.prompt,
    contextTokenBudget: foreground.contextTokenBudget,
    reserveTokens: foregroundSettings.getCompactionReserveTokens(),
    toolSchemaTokens: estimateToolSchemaTokenPressure(session.agent.state.tools),
    replay: {
      model: foreground.model,
      sessionId: params.sessionId,
      authProfileId: params.runtimePlan?.auth.forwardedAuthProfileId ?? params.authProfileId,
      enabled:
        foreground.model.provider === effectiveModel.provider &&
        foreground.model.id === effectiveModel.id
          ? compactionReplayEnabled
          : resolveCompactionReplayEligibility(foreground.model, {
              extraParams: params.runtimePlan?.transport.extraParams,
              apiKey: params.resolvedApiKey,
            }),
    },
  });
  assertActive();
  return { originalMessages, skipCompaction: !pressure.shouldCompact };
}
