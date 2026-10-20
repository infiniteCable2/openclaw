import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureClientVoiceAgentSessionEntry } from "../../talk/client-voice-session.js";
import { resolveSandboxedSessionCreation } from "../operator-session-run.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import {
  captureGatewayPrivateConversationAudience,
  resolveGatewayInputParticipant,
} from "../session-input-participant.js";
import { createTalkOperatorRunSource } from "./operator-run-source.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

/** Speech and realtime relay creation retain the same original caller until native COMMIT. */
export async function ensureGatewayTalkSessionEntry(
  params: Parameters<typeof createTalkOperatorRunSource>[0] & {
    cfg: OpenClawConfig;
    target: PreparedTalkSessionTarget;
    assertCurrent: SessionSourceAssertion;
    onCreatedSessionCommitted?: Parameters<
      typeof ensureClientVoiceAgentSessionEntry
    >[0]["onCreatedSessionCommitted"];
  },
): Promise<string> {
  const { client, context, cfg, target, assertCurrent } = params;
  const participant = resolveGatewayInputParticipant(client);
  const source =
    participant?.type === "profile"
      ? await createTalkOperatorRunSource({ client, context })({ assertCurrent })
      : undefined;
  try {
    return await ensureClientVoiceAgentSessionEntry({
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
      cfg,
      chatType: "direct",
      privateAudience: captureGatewayPrivateConversationAudience({
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        participant,
        operatorAuthority: source?.authority,
        assertCurrent,
      }),
      creation:
        resolveSandboxedSessionCreation(client, cfg) ?? resolveOperatorSessionCreation(client),
      assertCommitAllowed: assertCurrent,
      onCreatedSessionCommitted: params.onCreatedSessionCommitted,
    });
  } finally {
    source?.release();
  }
}
