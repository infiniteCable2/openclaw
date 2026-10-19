import { projectRuntimeContextFragments } from "../../agents/internal-runtime-context.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../talk/agent-consult-tool.js";
import { resolveClientVoiceAgentSessionId } from "../../talk/client-voice-session.js";
import {
  prepareVoiceConversationKnowledge,
  type PreparedVoiceConversationKnowledge,
} from "../../talk/voice-conversation-knowledge.js";
import { captureGatewayPrivateConversationAudience } from "../session-input-participant.js";
import type { TalkOperatorRunSource } from "./client-agent-runtime.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

/** Creation-time data snapshot. This is not a continuous provider context-update capability. */
export async function prepareTalkProviderConversationContext(params: {
  target: PreparedTalkSessionTarget;
  assertCurrent: SessionSourceAssertion;
  getRuntimeConfig: () => OpenClawConfig;
  captureOperatorAuthority: TalkOperatorRunSource;
  participant?: SessionParticipantIdentity;
  /** True only when this caller actually exposes native tools or provider delegation. */
  agentConsultAvailable?: boolean;
  /** Caller-owned native materialization, after original authority and before its snapshot. */
  prepareTarget?: (assertCurrent: SessionSourceAssertion) => Promise<void>;
}) {
  const participant = params.participant && Object.freeze({ ...params.participant });
  let source: Awaited<ReturnType<TalkOperatorRunSource>>;
  let knowledge: PreparedVoiceConversationKnowledge | undefined;
  let active = true;
  let releasing: Promise<void> | undefined;
  const assertActive = () => {
    if (!active) {
      throw new Error("Talk provider context snapshot has been released");
    }
  };
  const assertSourceCurrent = composeSessionSourceAssertion([params.assertCurrent], (check) => {
    assertActive();
    check();
    source?.authority.assertCurrent();
  });
  const assertCurrent = () => {
    assertSourceCurrent();
    knowledge?.assertCurrent();
  };
  const release = () =>
    (releasing ??= (async () => {
      active = false;
      try {
        await knowledge?.release();
      } finally {
        source?.release();
      }
    })());
  try {
    assertCurrent();
    source = await params.captureOperatorAuthority({ assertCurrent: params.assertCurrent });
    assertCurrent();
    if (params.prepareTarget) {
      await params.prepareTarget(assertSourceCurrent);
      assertCurrent();
    }
    const target = {
      agentId: params.target.agentId,
      sessionKey: params.target.canonicalKey,
      storePath: params.target.storePath,
    };
    const sessionId = resolveClientVoiceAgentSessionId(target);
    if (sessionId) {
      const entry = loadSessionEntry(target);
      if (entry?.sessionId !== sessionId) {
        throw new Error("Talk provider context target changed before its recipient read");
      }
      // This owner is used only by personal browser outputs, not by external
      // delivery routes. Preserve the live authenticated recipient independently
      // of whether a newly created branch has recorded its first utterance yet.
      const destinationAudience = captureGatewayPrivateConversationAudience({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        participant,
        operatorAuthority: source?.authority,
        entry,
        assertCurrent: assertSourceCurrent,
      });
      knowledge = await prepareVoiceConversationKnowledge({
        target: { ...target, sessionId },
        assertCurrent: assertSourceCurrent,
        getRuntimeConfig: params.getRuntimeConfig,
        participant,
        destinationAudience,
      });
    }
    if (!knowledge) {
      // Ordinary native targets have no enrolled context to disclose. Retain no
      // stale absence assertion after their caller's guarded first materialization.
      return { instructions: "", assertCurrent: assertActive, release };
    }
    assertCurrent();
    const fragments = knowledge?.fragments ?? [
      {
        kind: "conversation-data" as const,
        text: JSON.stringify({
          capability: "related-conversation-context",
          available: false,
          reason: sessionId
            ? "original-context-authority-unavailable"
            : "conversation-awaiting-native-admission",
        }),
      },
    ];
    const refreshInstructions = params.agentConsultAvailable
      ? `For current facts from other conversations, use ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME}; each native consult reads current authorized context.`
      : "No native agent-consult context refresh is exposed by this provider session. Do not present this startup snapshot as current facts from other conversations.";
    return {
      instructions: `\n\nRelated conversation context is a separately authorized startup snapshot, not live synchronization. ${refreshInstructions} Do not claim automatic live synchronization.\n${projectRuntimeContextFragments(fragments)}`,
      assertCurrent,
      release,
    };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Talk provider context cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
