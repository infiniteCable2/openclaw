import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConversationMode } from "../../../config/agent-conversation-mode.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ConversationPrivateAudience } from "../../../sessions/conversation-private-audience.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../../talk/agent-run-control-shared.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session-write.js";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL } from "../../../talk/describe-view-tool.js";
import type { InternalRealtimeVoiceProviderCapabilities } from "../../../talk/provider-internal.js";
import { resolveSandboxedSessionCreation } from "../../operator-session-run.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandler } from "../../server-methods/types.js";
import { resolveOperatorSessionCreation } from "../../session-creation-provenance.js";
import type { resolveGatewayInputParticipant } from "../../session-input-participant.js";
import { formatForLog } from "../../ws-log.js";
import { prepareTalkProviderConversationContext } from "../conversation-context.js";
import { createTalkOperatorRunSource } from "../operator-run-source.js";
import { buildRealtimeInstructions } from "../session-config.js";
import { readTalkRealtimeInitialItems } from "../session-history.js";
import type { PreparedTalkSessionTarget } from "../session-target.types.js";

/** Prepare the authorized initial conversation through the native storage and context owners. */
export async function prepareTalkClientContext(
  request: Parameters<GatewayRequestHandler>[0],
  options: {
    target: PreparedTalkSessionTarget;
    runtimeConfig: OpenClawConfig;
    inputParticipant: ReturnType<typeof resolveGatewayInputParticipant>;
    assertTargetCurrent: SessionSourceAssertion;
    providerCapabilities: InternalRealtimeVoiceProviderCapabilities | undefined;
    providerInstructions: string;
    wantsCameraFrames: boolean;
  },
) {
  const { context, client, sessionMutationAuthorization, sessionMutationCommitGuard } = request;
  const {
    target,
    runtimeConfig,
    inputParticipant,
    assertTargetCurrent,
    providerCapabilities,
    providerInstructions,
    wantsCameraFrames,
  } = options;
  const requester = readGatewayRequestMutationAuthority(request);
  const { agentId } = target;
  const sessionTarget = { agentId, sessionKey: target.canonicalKey, storePath: target.storePath };
  let conversationContext:
    | Awaited<ReturnType<typeof prepareTalkProviderConversationContext>>
    | undefined;
  try {
    let startupEnsuredSessionId: string | undefined;
    conversationContext = await prepareTalkProviderConversationContext({
      target,
      assertCurrent: assertTargetCurrent,
      getRuntimeConfig: context.getRuntimeConfig,
      captureOperatorAuthority: createTalkOperatorRunSource({ client, context }),
      participant: inputParticipant,
      agentConsultAvailable:
        providerCapabilities?.supportsToolCalls !== false ||
        providerCapabilities?.handlesAgentConsult === true,
      ...(resolveAgentConversationMode(runtimeConfig, agentId) === "branches"
        ? {
            prepareTarget: async (
              assertSourceCurrent: SessionSourceAssertion,
              privateAudience: ConversationPrivateAudience | undefined,
            ) => {
              // A branch is an explicitly begun conversation attempt. Its native
              // row must exist before the authorized Knowledge snapshot; retain
              // that attempt even when provider startup subsequently fails.
              startupEnsuredSessionId = await ensureClientVoiceAgentSessionEntry({
                chatType: "direct",
                privateAudience,
                ...sessionTarget,
                cfg: runtimeConfig,
                getRuntimeConfig: context.getRuntimeConfig,
                creation:
                  resolveSandboxedSessionCreation(client, runtimeConfig) ??
                  resolveOperatorSessionCreation(client),
                assertCommitAllowed: composeSessionSourceAssertion([
                  sessionMutationCommitGuard,
                  assertSourceCurrent,
                ]),
                requester: requester.assertCurrent,
                source: sessionMutationAuthorization?.assertCurrent,
                prepareWorkerGrant: sessionMutationAuthorization?.prepareWorkerGrant,
                onCommittedSource: (readSource, entry) =>
                  sessionMutationAuthorization?.recordCreatedSession?.({
                    ...sessionTarget,
                    sessionId: entry.sessionId,
                    entry,
                    lifecycleRevision: entry.lifecycleRevision,
                    readSource,
                  }),
              });
              sessionMutationAuthorization?.assertTargetCurrent({
                ...sessionTarget,
                ensuredSessionId: startupEnsuredSessionId,
              });
            },
          }
        : {}),
    });
    const contextualProviderInstructions = providerInstructions + conversationContext.instructions;
    const initialItems = await readTalkRealtimeInitialItems(target, assertTargetCurrent);
    assertTargetCurrent();
    const controlSource: "delegation" | "transcript" =
      providerCapabilities?.handlesAgentConsult === true ? "delegation" : "transcript";
    const tools =
      providerCapabilities?.supportsToolCalls === false
        ? []
        : [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL];
    if (wantsCameraFrames && tools.length > 0) {
      tools.push(REALTIME_VOICE_DESCRIBE_VIEW_TOOL);
    }
    const instructions =
      controlSource === "delegation"
        ? normalizeOptionalString(contextualProviderInstructions)
        : buildRealtimeInstructions(contextualProviderInstructions);

    return {
      conversationContext,
      startupEnsuredSessionId,
      initialItems,
      controlSource,
      tools,
      instructions,
    };
  } catch (error) {
    try {
      await conversationContext?.release();
    } catch (cleanupError) {
      context.logGateway.warn(
        `talk context snapshot cleanup failed: ${formatForLog(cleanupError)}`,
      );
    }
    throw error;
  }
}
