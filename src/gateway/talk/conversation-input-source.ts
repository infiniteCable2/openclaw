import type { MsgContext } from "../../auto-reply/templating.js";
import { buildHostChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { bindHostConversationContextGatewayResolver } from "../../channels/message-access/admission-evidence.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertExternalConversationTarget } from "../../routing/conversation-mode.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { createConversationInputAdmission } from "../../talk/conversation-input-admission.js";
import type { ConversationInputSourceV1 } from "../../talk/conversation-input.types.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import type { TalkOperatorRunSource } from "./client-agent-runtime.js";
import type { TalkAgentConsultAuthority } from "./client-gateway-control.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

/** A real Gateway caller supplies authority; the audio connection supplies only input liveness. */
export function createGatewayTalkConversationInputSource(input: {
  target: PreparedTalkSessionTarget;
  conversationId: string;
  getRuntimeConfig(): OpenClawConfig;
  captureOperatorAuthority: TalkOperatorRunSource;
  authority: TalkAgentConsultAuthority;
  /** Original Gateway participant owner, not caller display metadata or device identity. */
  participant?: SessionParticipantIdentity;
  assertInputCurrent(): void;
  resolveGatewayContext: GatewayContextResolver;
}): ConversationInputSourceV1 {
  const params = {
    ...input,
    target: Object.freeze({ ...input.target }),
    participant: input.participant && Object.freeze({ ...input.participant }),
  };
  return Object.freeze({
    version: 1 as const,
    async admitInput(scope) {
      scope.signal?.throwIfAborted();
      params.assertInputCurrent();
      if (
        scope.agentId !== params.target.agentId ||
        scope.conversationId !== params.conversationId
      ) {
        throw new Error("Talk input does not match its original prepared target");
      }
      const facts = await prepareSessionMutationFacts({
        cfg: params.getRuntimeConfig(),
        agentId: params.target.agentId,
        sessionKey: params.target.canonicalKey,
        preserveQualifiedAddress: true,
      });
      let source: Awaited<ReturnType<TalkOperatorRunSource>>;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          source?.release();
        } finally {
          facts.release();
        }
      };
      try {
        const original = facts.readCurrent(params.getRuntimeConfig()).target;
        if (
          !original ||
          original.agentId !== params.target.agentId ||
          original.canonicalKey !== params.target.canonicalKey ||
          original.storePath !== params.target.storePath
        ) {
          throw new Error("Talk input lost its prepared conversation target");
        }
        const sessionId = original.entry.sessionId;
        const lifecycleRevision = original.entry.lifecycleRevision;
        const chatType = original.entry.chatType ?? "direct";
        // The native owner supplies resident facts. Rechecking does not run SQLite on the
        // Gateway thread, and media closure cannot revoke already accepted user work.
        const assertCurrent = () => {
          if (released) throw new Error("Talk input source is closed");
          const cfg = params.getRuntimeConfig();
          const current = facts.readCurrent(cfg).target;
          if (
            !current ||
            current.agentId !== original.agentId ||
            current.canonicalKey !== original.canonicalKey ||
            current.storePath !== original.storePath ||
            current.entry.sessionId !== sessionId ||
            current.entry.lifecycleRevision !== lifecycleRevision ||
            (current.entry.chatType ?? "direct") !== chatType
          ) {
            throw new Error("Talk input conversation incarnation changed");
          }
          assertExternalConversationTarget({
            cfg,
            agentId: current.agentId,
            sessionKey: current.canonicalKey,
            isSystemEvent: false,
            entry: current.entry,
          });
        };
        source = await params.captureOperatorAuthority({ assertCurrent });
        params.assertInputCurrent();
        scope.signal?.throwIfAborted();
        assertCurrent();
        if (!source)
          throw new Error("Talk conversation requires its original authenticated caller");
        const capturedSource = source;
        capturedSource.authority.assertCurrent();
        if (
          params.participant?.type === "profile" &&
          params.participant.id !== capturedSource.authority.profileId
        ) {
          throw new Error("Talk participant does not match the original authenticated caller");
        }
        const promptedAt = Date.now();
        return createConversationInputAdmission({
          scope,
          source: { channelId: "webchat", sessionKey: params.target.canonicalKey },
          operatorAuthority: capturedSource.authority,
          ...(params.participant
            ? { participant: { identity: params.participant, promptedAt } }
            : {}),
          assertCurrent,
          assertInputCurrent: params.assertInputCurrent,
          release,
          prepareContext(text): MsgContext {
            assertCurrent();
            capturedSource.authority.assertCurrent();
            const context = buildHostChannelInboundEventContext({
              channel: "webchat",
              channelIngress: "unsupported",
              messageId: scope.inputId,
              timestamp: promptedAt,
              from: "gateway-talk",
              sender: { id: capturedSource.authority.profileId },
              conversation: { kind: chatType, id: params.conversationId },
              route: {
                agentId: params.target.agentId,
                routeSessionKey: params.target.canonicalKey,
              },
              reply: { to: params.target.canonicalKey },
              message: { rawBody: text, sourceModality: "audio", inboundEventKind: "user_request" },
              access: { commands: { authorized: false } },
              extra: params.authority.replyCaller,
            });
            if (params.participant) {
              prepareSessionParticipantInput(context, params.participant, promptedAt);
            }
            context.CommandInterpretationSuppressed = true;
            bindHostConversationContextGatewayResolver({
              context,
              resolveGatewayContext: params.resolveGatewayContext,
              assertCurrent() {
                assertCurrent();
                capturedSource.authority.assertCurrent();
              },
            });
            return context;
          },
        });
      } catch (error) {
        release();
        throw error;
      }
    },
  });
}
