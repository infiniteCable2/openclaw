import type { MsgContext } from "../../auto-reply/templating.js";
import { buildHostChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { bindHostConversationContextGatewayResolver } from "../../channels/message-access/admission-evidence.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { assertExternalConversationTarget } from "../../routing/conversation-mode.js";
import { bindConversationPrivateAudience } from "../../sessions/conversation-private-audience.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { createConversationInputAdmission } from "../../talk/conversation-input-admission.js";
import type { ConversationInputSourceV1 } from "../../talk/conversation-input.types.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { captureGatewayPrivateConversationAudience } from "../session-input-participant.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import type { TalkOperatorRunSource } from "./client-agent-runtime.js";
import type { TalkAgentConsultAuthority } from "./client-gateway-control.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

const log = createSubsystemLogger("gateway/talk");

/** A real Gateway caller supplies authority; the audio connection supplies only input liveness. */
export function createGatewayTalkConversationInputSource(input: {
  target: PreparedTalkSessionTarget;
  conversationId: string;
  getRuntimeConfig(): OpenClawConfig;
  captureOperatorAuthority: TalkOperatorRunSource;
  authority: TalkAgentConsultAuthority;
  /** Original Gateway participant owner, not caller display metadata or device identity. */
  participant?: SessionParticipantIdentity;
  /** Only connection-owned preparation follows this signal; accepted inputs retain their own holds. */
  connectionAbortSignal?: AbortSignal;
  assertInputCurrent(this: void): void;
  resolveGatewayContext: GatewayContextResolver;
}): ConversationInputSourceV1 {
  const params = {
    ...input,
    target: Object.freeze({ ...input.target }),
    participant: input.participant && Object.freeze({ ...input.participant }),
  };
  const acquireOriginalSource = async (preparation: {
    assertPreparing(): void;
    /** An opening hold belongs to the connection; input holds keep their existing independent lifetime. */
    captureSignal?: AbortSignal;
    retainCleanup?: (release: () => void) => void;
  }) => {
    preparation.assertPreparing();
    const facts = await prepareSessionMutationFacts({
      cfg: params.getRuntimeConfig(),
      agentId: params.target.agentId,
      sessionKey: params.target.canonicalKey,
      preserveQualifiedAddress: true,
    });
    let source: Awaited<ReturnType<TalkOperatorRunSource>>;
    let released = false;
    let sourceReleased = false;
    let factsReleased = false;
    const release = () => {
      released = true;
      const failures: unknown[] = [];
      if (!sourceReleased) {
        try {
          source?.release();
          sourceReleased = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (!factsReleased) {
        try {
          facts.release();
          factsReleased = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Talk input source cleanup remains pending");
      }
    };
    preparation.retainCleanup?.(release);
    try {
      preparation.assertPreparing();
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
        if (released) {
          throw new Error("Talk input source is closed");
        }
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
      source = await params.captureOperatorAuthority({
        assertCurrent,
        ...(preparation.captureSignal ? { signal: preparation.captureSignal } : {}),
      });
      preparation.assertPreparing();
      assertCurrent();
      if (!source) {
        throw new Error("Talk conversation requires its original authenticated caller");
      }
      const capturedSource = source;
      capturedSource.authority.assertCurrent();
      if (
        params.participant?.type === "profile" &&
        params.participant.id !== capturedSource.authority.profileId
      ) {
        throw new Error("Talk participant does not match the original authenticated caller");
      }
      const audience = captureGatewayPrivateConversationAudience({
        agentId: params.target.agentId,
        sessionKey: params.target.canonicalKey,
        participant: params.participant,
        operatorAuthority: capturedSource.authority,
        entry: original.entry,
        assertCurrent() {
          assertCurrent();
          const entry = facts.readCurrent(params.getRuntimeConfig()).target?.entry;
          if (entry?.chatType !== "direct" || entry.publicShare !== undefined) {
            throw new Error("Talk private conversation was shared or changed audience");
          }
        },
      });
      return { original, source: capturedSource, audience, chatType, assertCurrent, release };
    } catch (error) {
      release();
      throw error;
    }
  };
  let connectionPreparation: Promise<void> | undefined;
  let releaseConnection: (() => void) | undefined;
  const connectionAbort = new AbortController();
  let removeConnectionListener = () => {};
  let closingConnection: Promise<void> | undefined;
  const closeConnection = (): Promise<void> => {
    if (closingConnection) {
      return closingConnection;
    }
    removeConnectionListener();
    connectionAbort.abort();
    const closing = Promise.resolve().then(async () => {
      await connectionPreparation?.catch(() => {});
      releaseConnection?.();
      releaseConnection = undefined;
    });
    closingConnection = closing;
    void closing.catch(() => {
      if (closingConnection === closing) {
        closingConnection = undefined;
      }
    });
    return closing;
  };
  const onConnectionAbort = () => {
    void closeConnection().catch(() => {
      log.warn("Talk connection recipient custody cleanup remains pending.");
    });
  };
  return Object.freeze({
    version: 1 as const,
    closeConnection,
    prepareConnection(options?: { signal?: AbortSignal }) {
      const originalSignal = params.connectionAbortSignal;
      // Existing callers without an original connection lifetime cannot retain a new hold.
      if (!originalSignal) {
        return Promise.resolve();
      }
      return (connectionPreparation ??= (async () => {
        const signal = AbortSignal.any([
          originalSignal,
          connectionAbort.signal,
          ...(options?.signal ? [options.signal] : []),
        ]);
        signal.addEventListener("abort", onConnectionAbort, { once: true });
        removeConnectionListener = () => signal.removeEventListener("abort", onConnectionAbort);
        const assertConnectionCurrent = () => {
          signal.throwIfAborted();
          params.assertInputCurrent();
        };
        const held = await acquireOriginalSource({
          assertPreparing: assertConnectionCurrent,
          captureSignal: signal,
          retainCleanup: (release) => {
            releaseConnection = release;
          },
        });
        try {
          assertConnectionCurrent();
          const privateAudience = held.audience;
          if (!privateAudience) {
            held.release();
            return;
          }
          const audience = Object.freeze({
            ...privateAudience,
            assertCurrent() {
              assertConnectionCurrent();
              privateAudience.assertCurrent();
            },
          });
          assertConnectionCurrent();
          const { openConversationKnowledgeRecipient } =
            await import("../../auto-reply/reply/conversation-knowledge-open.js");
          audience.assertCurrent();
          await openConversationKnowledgeRecipient({
            target: {
              agentId: params.target.agentId,
              sessionKey: params.target.canonicalKey,
              sessionId: held.original.entry.sessionId,
              storePath: params.target.storePath,
            },
            participant: params.participant,
            audience,
            getRuntimeConfig: params.getRuntimeConfig,
            signal,
          });
          audience.assertCurrent();
        } catch (error) {
          held.release();
          releaseConnection = undefined;
          removeConnectionListener();
          throw error;
        }
      })());
    },
    async admitInput(scope) {
      const assertPreparing = () => {
        scope.signal?.throwIfAborted();
        params.assertInputCurrent();
      };
      assertPreparing();
      if (
        scope.agentId !== params.target.agentId ||
        scope.conversationId !== params.conversationId
      ) {
        throw new Error("Talk input does not match its original prepared target");
      }
      const held = await acquireOriginalSource({ assertPreparing });
      const { source: capturedSource, audience, chatType, assertCurrent, release } = held;
      try {
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
            if (audience) {
              bindConversationPrivateAudience(context, audience);
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
