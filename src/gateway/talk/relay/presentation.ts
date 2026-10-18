import { publishTalkConnectionPresentation } from "../../../talk/session-registry.js";
import type { GatewayClient, GatewayRequestContext } from "../../server-methods/types.js";
import { relaySessions, type RelaySession } from "./state.js";

type PresentationRelay = Pick<
  RelaySession,
  "connId" | "closing" | "expiresAtMs" | "sessionTarget" | "presentationState"
>;
const relayOwner = {
  findSession: (id: string): PresentationRelay | undefined => relaySessions.get(id),
};

/** Publish the actual relay owner, never a caller-claimed key or a provider availability probe. */
export function publishTalkRealtimeRelayPresentation(
  params: {
    sessionId: string;
    connId: string;
    client: Pick<GatewayClient, "connId" | "invalidated" | "connectionSignal"> | null;
    context: Pick<GatewayRequestContext, "resolveGatewayContext">;
    hasCurrentClientAuthority?: () => boolean;
  },
  deps = relayOwner,
) {
  const { sessionId, connId, client, context, hasCurrentClientAuthority } = params;
  const session = deps.findSession(sessionId);
  const originalGateway = context.resolveGatewayContext?.();
  const assertCurrent = () => {
    if (
      !session ||
      deps.findSession(sessionId) !== session ||
      session.connId !== connId ||
      session.closing ||
      session.expiresAtMs <= Date.now() ||
      !client ||
      client.connId !== connId ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      hasCurrentClientAuthority?.() === false ||
      (context.resolveGatewayContext && context.resolveGatewayContext() !== originalGateway)
    ) {
      throw new Error("Talk realtime output source is no longer current");
    }
  };
  assertCurrent();
  if (!session) {
    throw new Error("Unknown Talk realtime relay");
  }
  return publishTalkConnectionPresentation(sessionId, {
    kind: "browser",
    channel: "talk",
    label: "Browser Talk",
    readTarget: {
      agentId: session.sessionTarget.agentId,
      sessionKey: session.sessionTarget.canonicalKey,
    },
    input: { audio: true, text: true },
    output: { audio: true },
    operations: ["current-turn-reply", "steer", "cancel-output"],
    state: () => {
      assertCurrent();
      return session.presentationState?.() ?? "preparing";
    },
    assertCurrent,
  });
}
