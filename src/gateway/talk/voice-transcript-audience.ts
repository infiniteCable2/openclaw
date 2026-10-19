import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { PrepareVoiceTranscriptAudience } from "../../talk/voice-transcript-audience.types.js";
import type { GatewayClient, GatewayRequestContext } from "../server-methods/shared-types.js";
import {
  captureGatewayPrivateConversationAudience,
  resolveGatewayInputParticipant,
} from "../session-input-participant.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import type { TalkOperatorRunSource } from "./client-agent-runtime.js";
import { createTalkOperatorRunSource } from "./operator-run-source.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

/** Capture per accepted utterance; normal transport closure cannot revoke accepted persistence. */
export function createGatewayVoiceTranscriptAudience(input: {
  target: PreparedTalkSessionTarget;
  expectedSessionId: string;
  client: GatewayClient | null;
  context: Pick<
    GatewayRequestContext,
    "getRuntimeConfig" | "getCommittedRuntimeConfig" | "resolveGatewayContext" | "getClientConnIds"
  >;
}): PrepareVoiceTranscriptAudience {
  const target = Object.freeze({ ...input.target });
  const expectedSessionId = input.expectedSessionId;
  const participant = resolveGatewayInputParticipant(input.client);
  const client = input.client;
  const connId = client?.connId;
  const getRuntimeConfig = input.context.getRuntimeConfig;
  const captureOperatorAuthority = createTalkOperatorRunSource({ client, context: input.context });
  // The creating native owner already selected/materialized this exact target.
  // A later utterance must not rebind a still-open voice record to a successor row.
  const entry =
    participant?.type === "profile" && participant.id !== GATEWAY_OWNER_PROFILE_ID
      ? loadSessionEntry({
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          storePath: target.storePath,
        })
      : undefined;
  const sessionId = entry?.sessionId;
  const lifecycleRevision = entry?.lifecycleRevision;
  return async () => {
    if (
      participant?.type !== "profile" ||
      !sessionId ||
      sessionId !== expectedSessionId ||
      !lifecycleRevision ||
      entry?.chatType !== "direct" ||
      entry.publicShare !== undefined
    ) {
      return undefined;
    }
    // Admission only. After this utterance is accepted, a normal socket close
    // removes its audience instead of revoking its original retained work owner.
    if (
      !client ||
      !connId ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      !input.context.getClientConnIds?.((candidate) => candidate === client).has(connId)
    ) {
      throw new Error("Voice transcript original input closed");
    }
    const facts = await prepareSessionMutationFacts({
      cfg: getRuntimeConfig(),
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
      preserveQualifiedAddress: true,
    });
    let source: Awaited<ReturnType<TalkOperatorRunSource>>;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        try {
          source?.release();
        } finally {
          facts.release();
        }
      }
    };
    try {
      const original = facts.readCurrent(getRuntimeConfig()).target;
      if (
        original.agentId !== target.agentId ||
        original.canonicalKey !== target.canonicalKey ||
        original.storePath !== target.storePath ||
        original.entry.sessionId !== sessionId ||
        original.entry.lifecycleRevision !== lifecycleRevision
      ) {
        throw new Error("Voice transcript lost its original native target");
      }
      const assertCurrent = () => {
        if (released) {
          throw new Error("Voice transcript audience has been released");
        }
        const current = facts.readCurrent(getRuntimeConfig()).target;
        if (
          current.agentId !== target.agentId ||
          current.canonicalKey !== target.canonicalKey ||
          current.storePath !== target.storePath ||
          current.entry.sessionId !== sessionId ||
          current.entry.lifecycleRevision !== lifecycleRevision ||
          current.entry.chatType !== "direct" ||
          current.entry.publicShare !== undefined
        ) {
          throw new Error("Voice transcript private audience or incarnation changed");
        }
      };
      // Fail closed on unknown/group/public rows without acquiring additional authority.
      if (original.entry.chatType !== "direct" || original.entry.publicShare !== undefined) {
        release();
        return undefined;
      }
      assertCurrent();
      source = await captureOperatorAuthority({ assertCurrent });
      const audience = captureGatewayPrivateConversationAudience({
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        participant,
        operatorAuthority: source?.authority,
        entry: original.entry,
        assertCurrent,
      });
      if (!audience) {
        release();
        return undefined;
      }
      return Object.freeze({ audience, release });
    } catch (error) {
      release();
      throw error;
    }
  };
}
