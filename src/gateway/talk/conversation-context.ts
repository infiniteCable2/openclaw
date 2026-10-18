import { projectRuntimeContextFragments } from "../../agents/internal-runtime-context.js";
import { resolveAgentConversationMode } from "../../config/agent-conversation-mode.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveClientVoiceAgentSessionId } from "../../talk/client-voice-session.js";
import {
  prepareVoiceConversationKnowledge,
  type PreparedVoiceConversationKnowledge,
} from "../../talk/voice-conversation-knowledge.js";
import type { TalkOperatorRunSource } from "./client-agent-runtime.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

/** Creation-time data snapshot. This is not a continuous provider context-update capability. */
export async function prepareTalkProviderConversationContext(params: {
  target: PreparedTalkSessionTarget;
  assertCurrent: SessionSourceAssertion;
  getRuntimeConfig: () => OpenClawConfig;
  captureOperatorAuthority: TalkOperatorRunSource;
  participant?: SessionParticipantIdentity;
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
  const assertCurrent = () => {
    assertActive();
    params.assertCurrent();
    source?.authority.assertCurrent();
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
    if (
      resolveAgentConversationMode(params.getRuntimeConfig(), params.target.agentId) !== "branches"
    ) {
      // No context was captured. The caller owns routing/creation authorization,
      // including adoption of its guarded first write; do not retain its earlier
      // absent-row assertion as a second authority after that materialization.
      return { instructions: "", assertCurrent: assertActive, release };
    }
    source = await params.captureOperatorAuthority({ assertCurrent: params.assertCurrent });
    assertCurrent();
    const target = {
      agentId: params.target.agentId,
      sessionKey: params.target.canonicalKey,
      storePath: params.target.storePath,
    };
    const sessionId = resolveClientVoiceAgentSessionId(target);
    if (sessionId) {
      knowledge = await prepareVoiceConversationKnowledge({
        target: { ...target, sessionId },
        assertCurrent: params.assertCurrent,
        getRuntimeConfig: params.getRuntimeConfig,
        participant,
      });
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
    return {
      instructions: `\n\nRelated conversation context is a separately authorized startup snapshot, not live synchronization. Native session tools may inspect current authorized conversations.\n${projectRuntimeContextFragments(fragments)}`,
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
