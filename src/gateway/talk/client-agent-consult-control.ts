import type { prepareEmbeddedAgentRunCompletionClaim } from "../../agents/embedded-agent-runner/runs.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { resolveInboundReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-tool-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { prepareRealtimeVoiceAgentExecutionContext } from "../../talk/agent-consult-runtime.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import {
  authorizeObservedClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
} from "../../talk/client-voice-confirmation.js";
import type { TalkAgentConsultSource } from "./client-agent-consult.types.js";
import type { TalkAgentConsultAuthority } from "./client-gateway-control.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

export function prepareTalkClientControlAuthority(params: {
  config: OpenClawConfig;
  sessionTarget: PreparedTalkSessionTarget;
  authority: TalkAgentConsultAuthority;
  source?: "reply" | "attempt";
  agentRuntime: ReturnType<typeof createPluginRuntime>["agent"];
}) {
  const prepared = prepareRealtimeVoiceAgentExecutionContext({
    cfg: params.config,
    agentRuntime: params.agentRuntime,
    agentId: params.sessionTarget.agentId,
    sessionKey: params.sessionTarget.canonicalKey,
    storePath: params.sessionTarget.storePath,
    messageProvider: "webchat",
    ...params.authority,
  });
  if (params.source !== "reply") {
    return prepared.toolAuthorityOverlay;
  }
  if (!params.authority.replyCaller) {
    throw new Error("Talk chat caller authority is unavailable");
  }
  // GA consultation uses the normal authenticated chat ingress. Direct voice
  // has no trace/client/reviewer capabilities and must never inherit these.
  const ctx = params.authority.replyCaller;
  return resolveInboundReplyToolAuthorityOverlay({
    ctx,
    sessionEntry: prepared.sessionEntry,
    senderIsOwner: resolveCommandAuthorization({
      ctx,
      cfg: params.config,
      commandAuthorized: false,
    }).senderIsOwner,
    toolsAllow: params.authority.toolsAllow,
    disableTools: false,
  });
}

/** Resolve steering through the same backend publication and caller custody as consultation. */
export async function controlTalkClientAgentConsult(params: {
  owner: {
    registered: Promise<unknown>;
    identity?: { runId: string; sessionId: string };
    signal?: AbortSignal;
    completionClaim?: ReturnType<typeof prepareEmbeddedAgentRunCompletionClaim>;
    source: TalkAgentConsultSource;
    voiceSessionId?: string;
  };
  config: OpenClawConfig;
  sessionTarget: PreparedTalkSessionTarget;
  isCurrent: (sessionId?: string) => boolean;
  assertCurrent?: () => void;
  getToolAuthorityOverlay: (source: "reply" | "attempt") => ReplyToolAuthorityOverlay;
  text: string;
  signal?: AbortSignal;
  mode: "steer" | "followup" | "cancel" | "status";
  onQueueAccepted?: (accepted: boolean) => void;
}) {
  params.signal?.throwIfAborted();
  await params.owner.registered;
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  const { identity, signal, completionClaim } = params.owner;
  if (!completionClaim || !identity || !signal || !params.isCurrent(identity.sessionId)) {
    throw new Error("The active Talk consult is no longer current");
  }
  const { agentId, canonicalKey, storePath } = params.sessionTarget;
  let confirmationRetryContext: string | undefined;
  return await controlRealtimeVoiceAgentRun({
    sessionKey: canonicalKey,
    runTarget: {
      runId: identity.runId,
      signal,
      isCurrent: (sessionId) => {
        params.assertCurrent?.();
        return (
          params.signal?.aborted !== true &&
          params.isCurrent(sessionId) &&
          completionClaim.resolveCurrentRegistration() !== undefined
        );
      },
    },
    getToolAuthorityOverlay: () => {
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
      if (!params.isCurrent(identity.sessionId)) {
        throw new Error("The active Talk consult is no longer current");
      }
      const registration = completionClaim.resolveCurrentRegistration();
      if (!registration) {
        throw new Error("The active Talk consult backend is no longer current");
      }
      return params.getToolAuthorityOverlay(registration.toolAuthority.source);
    },
    prepareToolAuthorityOverlay: async (overlay) => {
      const registration = completionClaim.resolveCurrentRegistration();
      if (!registration) {
        throw new Error("The active Talk consult backend is no longer current");
      }
      const projected = await registration.toolAuthority.projectAsync(overlay);
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
      if (
        !projected ||
        !params.isCurrent(identity.sessionId) ||
        completionClaim.resolveCurrentRegistration()?.toolAuthority !== registration.toolAuthority
      ) {
        throw new Error("The active Talk consult caller authority no longer matches");
      }
      if (params.owner.source === "native-delegation" && params.owner.voiceSessionId) {
        const grant = authorizeObservedClientVoiceConfirmation({
          agentId,
          voiceSessionId: params.owner.voiceSessionId,
        });
        if (grant && bindAuthorizedClientVoiceConfirmation({ grant, runId: identity.runId })) {
          confirmationRetryContext = grant.retryContext;
        }
      }
    },
    text: params.text,
    getSteeringContext: () =>
      [
        confirmationRetryContext,
        params.mode === "followup"
          ? "The caller interrupted audio delivery. Earlier assistant output may not have been heard. " +
            "In your next answer, consolidate still-relevant results from the preceding request with this new input. " +
            "Respect corrections or cancellations; do not repeat completed tool actions just to repeat their results."
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n") || undefined,
    createUserTurnTranscriptRecorder:
      params.owner.source === "native-delegation"
        ? (text) =>
            createUserTurnTranscriptRecorder({
              input: { text, display: false },
              target: {
                agentId,
                sessionId: identity.sessionId,
                sessionKey: canonicalKey,
                storePath,
                expectedSessionId: identity.sessionId,
                sessionEntry: undefined,
                config: params.config,
              },
            })
        : undefined,
    mode: params.mode,
    ...(params.mode === "followup" ? { waitForTranscriptCommit: true } : {}),
    ...(params.onQueueAccepted ? { onQueueAccepted: params.onQueueAccepted } : {}),
  });
}
